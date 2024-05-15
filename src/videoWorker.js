

addEventListener('message', receiveMessage);

let sdpInfo = null;
let rtpSession = null;
let videoCHID = -1;
let videoRtpSessionsArray = [];

function  receiveMessage(event) {
    //console.log(event.data)
    let message = event.data;

    switch (message.type) {
        case 'sdpInfo':
            sdpInfo = message.data;

            initRTPSession(sdpInfo.sdpInfo);
        case 'rtpDataArray':
            //console.log(message.data.length)
            for (let num = 0; num < message.data.length; num++) {
                receiveMessage({
                    'type': 'rtpData',
                    'data': message.data[num],
                });
            }
            break;
        case 'rtpData':
            videoCHID = message.data.rtspInterleave[1];
            if (typeof videoRtpSessionsArray[videoCHID] !== "undefined") {
                videoRtpSessionsArray[videoCHID].remuxRTPData(message.data.rtspInterleave,
                    message.data.header, message.data.payload);
            }else { // RTCP包
                //console.log('Interleave:  ' + videoCHID);
                //console.log(message.data.rtspInterleave, message.data.header);
                //return;
            }
            break;
    }
}

function initRTPSession(sdpInfo) {
    for(let [i, len] = [0, sdpInfo.length]; i < len; i++) {
        if(sdpInfo[i].codecName === 'H264') {
            //console.log(sdpInfo)
            rtpSession = new H264Session();
            rtpSession.init();
            rtpSession.rtpSessionCallback = RtpReturnCallback;
            if(sdpInfo[i].Framerate) {
                rtpSession.setFrameRate(sdpInfo[i].Framerate);
            }
        }

        if(rtpSession !== null) {
            videoCHID = sdpInfo[i].RtpInterlevedID;
            videoRtpSessionsArray[videoCHID] = rtpSession;
        }
    }
}

function RtpReturnCallback(dataInfo) {

    if(dataInfo == null || dataInfo == undefined) {
        //console.log('数据为空')
        return;
    }
    let mediaData = dataInfo;
    if(mediaData.decodeMode === 'canvas') {
        sendMessage('YUVData', mediaData.frameData);
        return;
    }
    //console.log( mediaData.SEIInfo)
    if(mediaData.initSegmentData !== null && mediaData.initSegmentData !== undefined) {
        //sendMessage('codecInfo', mediaData.codecInfo)
        //sendMessage('initSegment', mediaData.initSegmentData);
        sendMessage('videoInit', mediaData);
        sendMessage('firstvideoTimeStamp', mediaData.timeStamp);

    }else if(mediaData.SEIInfo !== null && mediaData.SEIInfo !== undefined) {//SEI信息
        sendMessage('SEI', mediaData.SEIInfo);
    }

    if (mediaData.frameData && mediaData.frameData.length > 0) {
        sendMessage('videoTimeStamp', mediaData.timeStamp);
        sendMessage('mediaSample', mediaData.mediaSample);
        //console.log(mediaData.frameData.length)
        sendMessage('videoRender', mediaData.frameData);
    }
    mediaData = null;
}

function sendMessage(type, data) {
    let event = {
        type: type,
        data: data
    }
    if(type === 'videoRender') {
        postMessage(event, [data.buffer]);
    }else {
        postMessage(event);
    }
    event = null;
}


function H264Session() {
    let rtpTimeStamp = 0;
    let size1M = 1048576; //1024 * 1024
    let inputBuffer = new Uint8Array(size1M);
    let spsSegment = null;
    let ppsSegment = null;

    let SPSParser = null;

    let width = 0;
    let height = 0;
    let inputLength = 0;

    let initalSegmentFlag = true; //用于确定是否是initSegment
    let initalMediaFrameFlag = true;

    let frameRate = null; //根据SDP或者SPS设置
    let preSample = null; //上一个Sample

    let inputSegBufferSub = null;

    //MSE使用的数据以及相关配置，顺序codecInfo -> initSegmentData -> mediaSample -> frameData
    //时间戳用于绘制人脸框
    let decodedData = {
        frameData: null, //视频数据
        timeStamp: null, //时间戳
        initSegmentData: null, //MP4配置,用于initsegment
        mediaSample: null, //使用duration控制每一帧的播放时间
        codecInfo: "", //MSE init时传入，用于创建mediasource
    };

    let decodeMode = 'video';
    let outputSize = 0;
    let curSize = 0;

    const PREFIX = new Uint8Array(['0x00', '0x00', '0x00', '0x01']);

    let firstIframe = false;

    let SEIInfo = {
        ivs: null,
        timestamp:null,
    };

    let preWidth = null,
        preHeight = null;
    let resetTimeCount = 0;
    let lastTimeStamp = 0;
    //const RESETTIME = 162000000;
    const RESETTIME = 4320000;

    let lastTime =0;
    function constructor() {

    }

    constructor.prototype = {
        init() {
            SPSParser = new H264SPSParser();
            this.resolutionChangedCallback = ()=>{};
        },

        remuxRTPData(rtspInterleaved, rtpHeader, rtpPayload) {
            //console.log(rtspInterleaved)
            //console.log(rtpHeader)
            let PaddingSize = 0;
            let extensionHeaderLen = 0; //如果RtpHeader.X=1，则在RTP报头后跟有一个扩展报头
            let PAYLOAD = null;
//console.log(rtpHeader)
//console.log(rtspInterleaved, rtpHeader, rtpPayload.subarray(0,5))
            let RtpHeader = {
                V: rtpHeader[0] >>> 6,
                P: rtpHeader[0] & 0x20,
                X: rtpHeader[0] & 0x10,
                CC: rtpHeader[0] & 0x0F,
                M: (rtpHeader[1] & 0x80) >> 7,
                PT: rtpHeader[1] & 127,
                SN: (rtpHeader[2] << 8) + rtpHeader[3],
                timeStamp: (rtpHeader[4] << 24) + (rtpHeader[5] << 16) + (rtpHeader[6] << 8) + rtpHeader[7],
                SSRC: (rtpHeader[8] << 24) + (rtpHeader[9] << 16) + (rtpHeader[10] << 8) + rtpHeader[11],
            };
            if (RtpHeader.P) { //填充
                PaddingSize = rtpPayload[rtpPayload.length - 1];
                console.log("Padding - " + PaddingSize);
            }

            if (RtpHeader.X) { //扩展
                extensionHeaderLen = (((rtpPayload[2] << 8) | rtpPayload[3]) * 4) + 4;
                console.log('X: ' + rtpPayload[0])
            }
//console.log('extensionHeaderLen: '+ extensionHeaderLen)
            PAYLOAD = rtpPayload.subarray(extensionHeaderLen, rtpPayload.length - PaddingSize);
            rtpTimeStamp = RtpHeader.timeStamp;
            /* 载荷结构(https://blog.csdn.net/davebobo/article/details/52994596)
            +---------------+
            |0|1|2|3|4|5|6|7|
            +-+-+-+-+-+-+-+-+
            |F|NRI|  Type   |
            +---------------+
            Type = 1-23 单个NAL单元包
            Type = 24,25, 26, 27聚合包
            Type = 28，29, 分片单元
            */
            let nalType = (PAYLOAD[0] & 0x1f);
            let end = false;
            switch (nalType) {
                case 6: //SEI
                    //console.log(PAYLOAD, String.fromCharCode.apply(null, PAYLOAD))
                    let SEI = SEIParse(PAYLOAD);
                    if(SEI) {
                        SEIInfo.ivs = SEI;
                        SEIInfo.timestamp = rtpTimeStamp;
                    }
                    //console.log('SEI time: ', rtpTimeStamp)
                    //console.log(rtpTimeStamp)
                    break;
                case 7: //SPS
                    //console.log('SPS');
                    SPSParser.parse(removeH264or5EmulationBytes(PAYLOAD));
                    let sizeInfo = SPSParser.getSizeInfo();
                    //console.log(SPSParser.getSpsMap())
                    width = sizeInfo.width;
                    height = sizeInfo.height;

                    if(preWidth !== width || preHeight !== height) {
                        console.log('resolution changed!');
                        console.log('preWidth: ', preWidth, ' preHeight: ', preHeight, ' width: ', width, ' height: ', height);
                        preWidth = width;
                        preHeight = height;
                    }
                    inputBuffer = setBuffer(inputBuffer, PREFIX);
                    inputBuffer = setBuffer(inputBuffer, PAYLOAD);
                    spsSegment = PAYLOAD;
                    //console.log('width： ',width, 'height: ', height)
                    curSize = sizeInfo.decodeSize;
                    firstIframe = true;
//console.log(spsSegment)
                    if (frameRate === null) {
                        frameRate = SPSParser.getFPS();
                    }
                    break;
                case 8: //PPS
                    //console.log('PPS')
                    inputBuffer = setBuffer(inputBuffer, PREFIX);
                    inputBuffer = setBuffer(inputBuffer, PAYLOAD);
                    ppsSegment = PAYLOAD;
//console.log(ppsSegment)
                    break;
                case 28: //FU
                    //console.log('FU');
                    let startBit = ((PAYLOAD[1] & 0x80) === 0x80),
                        endBit = ((PAYLOAD[1] & 0x40) === 0x40),
                        fuType = PAYLOAD[1] & 0x1f,
                        payloadStartIndex = 2;
                    //console.log('startBit: ' + startBit + ' endBit: ' + endBit)
                    //console.log('fuType: ' + fuType)
                    if (startBit === true && endBit === false) {
                        let newNalHeader = new Uint8Array(1);
                        newNalHeader[0] = ((PAYLOAD[0] & 0xe0) | fuType);

                        inputBuffer = setBuffer(inputBuffer, PREFIX);
                        inputBuffer = setBuffer(inputBuffer, newNalHeader);
                        inputBuffer = setBuffer(inputBuffer, PAYLOAD.subarray(payloadStartIndex, PAYLOAD.length));
                    } else {
                        //console.log(startBit, endBit, 'endBit')
                        inputBuffer = setBuffer(inputBuffer,
                            PAYLOAD.subarray(payloadStartIndex, PAYLOAD.length));
                        end = true;
                    }
//console.log(startBit,endBit)
                    // if(endBit === true) {
                    //     end = true;
                    // }
                    break;
                case 1:
                    inputBuffer = setBuffer(inputBuffer, PREFIX);
                    inputBuffer = setBuffer(inputBuffer, PAYLOAD);
                    break;
                default:
                    //console.log('nalType: ' + nalType);
                    //console.log(PAYLOAD)
                    break;
            }

            let frameType = '';
//console.log('RtpHeader.M: ', RtpHeader.M)
            //check marker bit
            if (RtpHeader.M) {

                if (!firstIframe) {
                    inputLength = 0;
                    return;
                }

                // rtp时间戳周期为RESETTIME，如果单向递增，设为0
                if((rtpTimeStamp < lastTimeStamp) && ((lastTimeStamp - rtpTimeStamp) >(RESETTIME / 2))) { //判断lastTimeStamp远大于rtpTimeStamp，防止后一帧比前一帧先到的情况
                    //console.log(lastTimeStamp - rtpTimeStamp)
                    resetTimeCount ++;
                }
                rtpTimeStamp = rtpTimeStamp + RESETTIME * resetTimeCount;

                //SEI信息
                if(SEIInfo.timestamp === RtpHeader.timeStamp) {
                    SEIInfo.timestamp = rtpTimeStamp;
                    decodedData.SEIInfo = SEIInfo;

                    lastTime = rtpTimeStamp;
                }

                let inputBufferSub = inputBuffer.subarray(0, inputLength);
//console.log(inputBufferSub[4] & 0x1f)
                if ((inputBufferSub[4] & 0x1f) === 7) {
                    frameType = 'I';
                } else {
                    frameType = 'P';
                    //return;
                }
//console.log('frameType: ',frameType, (inputBufferSub[4] & 0x1f))
                if (!initalSegmentFlag) {
                    decodedData.initSegmentData = null;
                    decodedData.codecInfo = null;
                } else {
                    initalSegmentFlag = false;
                    const info = {
                        id: 1,
                        width: width,
                        height: height,
                        type: "video",
                        profileIdc: SPSParser.getSpsValue("profile_idc"),
                        profileCompatibility: 0,
                        levelIdc: SPSParser.getSpsValue("level_idc"),
                        sps: [spsSegment],
                        pps: [ppsSegment],
                        timescale: 1e3,
                        fps: frameRate
                    };
                    decodedData.initSegmentData = info;
                    decodedData.codecInfo = SPSParser.getCodecInfo();
                    //console.log(info.pps)
                }

                if (frameType === 'I') {
//console.log('ppsSegment: ', ppsSegment)
                    let h264parameterLength = spsSegment.length + ppsSegment.length + 8;
                    inputSegBufferSub = inputBufferSub.subarray(h264parameterLength, inputBufferSub.length);
                } else {
                    inputSegBufferSub = inputBufferSub.subarray(0, inputBufferSub.length);
                }

                let segSize = inputSegBufferSub.length - 4;
                //mp4 box头
                inputSegBufferSub[0] = (segSize & 0xFF000000) >>> 24;
                inputSegBufferSub[1] = (segSize & 0xFF0000) >>> 16;
                inputSegBufferSub[2] = (segSize & 0xFF00) >>> 8;
                inputSegBufferSub[3] = (segSize & 0xFF);

                decodedData.frameData = new Uint8Array(inputSegBufferSub);

                let sample = {
                    duration: Math.round((1 / frameRate) * 1000),
                    size: inputSegBufferSub.length,
                    frame_time_stamp: null,
                    frameDuration: null,
                };
                sample.frame_time_stamp = rtpTimeStamp; //Todo：暂时为null，通过帧率控制duration
                if (initalMediaFrameFlag) {
                    sample.frameDuration = 0;
                    initalMediaFrameFlag = false;
                } else {
                    if(frameRate) {
                        sample.frameDuration = Math.round(1000 / frameRate);
                    }else {
                        sample.frameDuration = (sample.frame_time_stamp - preSample.frame_time_stamp) / 90; // 时钟频率90000，timescale=1000
                    }
                }
                preSample = sample;

                decodedData.mediaSample = sample;

                decodedData.timeStamp = rtpTimeStamp;

                this.handleDecodedData(decodedData);
                inputLength = 0;
                decodedData.SEIInfo = null;
                inputSegBufferSub = null;
                lastTimeStamp = RtpHeader.timeStamp;
            }
        },

        set rtpSessionCallback(func) {
            this.handleDecodedData = func;
        },

        setFrameRate(fps) {
            frameRate = fps;
            //console.log('frameRate: ', frameRate)
        },

        setResolutionChangedCallback(callback) {
            this.resolutionChangedCallback = callback;
        }
    }

    return new constructor();

    function setBuffer(buffer1, buffer2) {
        let bufferTemp = buffer1;
        if ((inputLength + buffer2.length) > buffer1.length) {
            bufferTemp = new Uint8Array(buffer1.length + size1M);
        }

        bufferTemp.set(buffer2, inputLength);
        inputLength += buffer2.length;
        return bufferTemp;
    }
}




/**
 * 去除SPS中的Emulation字节
 * @param data SPS源数据
 * @returns {Array} 去除后Emulation字节后的SPS
 */
function removeH264or5EmulationBytes(data) {
    let toSize = 0;
    let i = 0;
    let to = [];
    let dataLength = data.length;
    while (i < dataLength) {
        if (i + 2 < dataLength && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) {
            to[toSize] = to[toSize + 1] = 0;
            toSize += 2;
            i += 3;
        } else {
            to[toSize] = data[i];
            toSize += 1;
            i += 1;
        }
    }
    return to;
}

/**
 * 解析SEI信息
 * @param data
 * @return {Array}
 */
function SEIParse(data) {

}

//import Map from './Map.js';

let BITWISE0x00000007 = 0x00000007;
let BITWISE0x7 = 0x7;
let BITWISE2 = 2;
let BITWISE3 = 3;
let BITWISE4 = 4;
let BITWISE5 = 5;
let BITWISE6 = 6;
let BITWISE8 = 8;
let BITWISE12 = 12;
let BITWISE15 = 15;
let BITWISE16 = 16;
let BITWISE32 = 32;
let BITWISE64 = 64;
let BITWISE255 = 255;
let BITWISE256 = 256;

function H264SPSParser() {
    let vBitCount = 0;
    let spsMap = null;
    let fps = null;


    function constructor() {
        spsMap = new Map();
    }

    constructor.prototype = {
        parse (pSPSBytes) {
            //console.log("=========================SPS START=========================");
            vBitCount = 0;
            spsMap.clear();

            // forbidden_zero_bit, nal_ref_idc, nal_unit_type
            spsMap.set("forbidden_zero_bit", readBits(pSPSBytes, 1));
            spsMap.set("nal_ref_idc", readBits(pSPSBytes, BITWISE2));
            spsMap.set("nal_unit_type", readBits(pSPSBytes, BITWISE5));

            // profile_idc
            spsMap.set("profile_idc", readBits(pSPSBytes, BITWISE8));
            spsMap.set("profile_compatibility", readBits(pSPSBytes, BITWISE8));

            // spsMap.set("constrained_set0_flag", readBits(pSPSBytes, 1));
            // spsMap.set("constrained_set1_flag", readBits(pSPSBytes, 1));
            // spsMap.set("constrained_set2_flag", readBits(pSPSBytes, 1));
            // spsMap.set("constrained_set3_flag", readBits(pSPSBytes, 1));
            // spsMap.set("constrained_set4_flag", readBits(pSPSBytes, 1));
            // spsMap.set("constrained_set5_flag", readBits(pSPSBytes, 1));
            // spsMap.set("reserved_zero_2bits", readBits(pSPSBytes, 2));

            // level_idc
            spsMap.set("level_idc", readBits(pSPSBytes, BITWISE8));
            spsMap.set("seq_parameter_set_id", ue(pSPSBytes, 0));

            let profileIdc = spsMap.get("profile_idc");
            let BITWISE100 = 100;
            let BITWISE110 = 110;
            let BITWISE122 = 122;
            let BITWISE244 = 244;
            let BITWISE44 = 44;
            let BITWISE83 = 83;
            let BITWISE86 = 86;
            let BITWISE118 = 118;
            let BITWISE128 = 128;
            let BITWISE138 = 138;
            let BITWISE139 = 139;
            let BITWISE134 = 134;

            if ((profileIdc === BITWISE100) || (profileIdc === BITWISE110) ||
                (profileIdc === BITWISE122) || (profileIdc === BITWISE244) ||
                (profileIdc === BITWISE44) || (profileIdc === BITWISE83) ||
                (profileIdc === BITWISE86) || (profileIdc === BITWISE118) ||
                (profileIdc === BITWISE128) || (profileIdc === BITWISE138) ||
                (profileIdc === BITWISE139) || (profileIdc === BITWISE134)) {
                spsMap.set("chroma_format_idc", ue(pSPSBytes, 0));
                if (spsMap.get("chroma_format_idc") === BITWISE3) {
                    spsMap.set("separate_colour_plane_flag", readBits(pSPSBytes, 1));
                }

                spsMap.set("bit_depth_luma_minus8", ue(pSPSBytes, 0));
                spsMap.set("bit_depth_chroma_minus8", ue(pSPSBytes, 0));
                spsMap.set("qpprime_y_zero_transform_bypass_flag", readBits(pSPSBytes, 1));
                spsMap.set("seq_scaling_matrix_present_flag", readBits(pSPSBytes, 1));

                if (spsMap.get("seq_scaling_matrix_present_flag")) {
                    let num = spsMap.get("chroma_format_idc") !== BITWISE3 ? BITWISE8 : BITWISE12;
                    let seqScalingListPresentFlag = new Array(num);
                    for (let i = 0; i < num; i++) {
                        seqScalingListPresentFlag[i] = readBits(pSPSBytes, 1);

                        if (seqScalingListPresentFlag[i]) {
                            let slNumber = i < BITWISE6 ? BITWISE16 : BITWISE64;
                            let lastScale = 8;
                            let nextScale = 8;
                            let deltaScale = 0;

                            for (let j = 0; j < slNumber; j++) {
                                if (nextScale) {
                                    deltaScale = se(pSPSBytes, 0);
                                    nextScale = (lastScale + deltaScale + BITWISE256) % BITWISE256;
                                }
                                lastScale = (nextScale === 0) ? lastScale : nextScale;
                            }
                        }
                    }
                    spsMap.set("seq_scaling_list_present_flag", seqScalingListPresentFlag);
                }
            }
            spsMap.set("log2_max_frame_num_minus4", ue(pSPSBytes, 0));
            spsMap.set("pic_order_cnt_type", ue(pSPSBytes, 0));

            if (spsMap.get("pic_order_cnt_type") === 0) {
                spsMap.set("log2_max_pic_order_cnt_lsb_minus4", ue(pSPSBytes, 0));
            } else if (spsMap.get("pic_order_cnt_type") === 1) {
                spsMap.set("delta_pic_order_always_zero_flag", readBits(pSPSBytes, 1));
                spsMap.set("offset_for_non_ref_pic", se(pSPSBytes, 0));
                spsMap.set("offset_for_top_to_bottom_field", se(pSPSBytes, 0));
                spsMap.set("num_ref_frames_in_pic_order_cnt_cycle", ue(pSPSBytes, 0));
                for (let numR = 0; numR < spsMap.get("num_ref_frames_in_pic_order_cnt_cycle"); numR++) {
                    spsMap.set("num_ref_frames_in_pic_order_cnt_cycle", se(pSPSBytes, 0));
                }
            }
            spsMap.set("num_ref_frames", ue(pSPSBytes, 0));
            spsMap.set("gaps_in_frame_num_value_allowed_flag", readBits(pSPSBytes, 1));
            spsMap.set("pic_width_in_mbs_minus1", ue(pSPSBytes, 0));
            spsMap.set("pic_height_in_map_units_minus1", ue(pSPSBytes, 0));
            spsMap.set("frame_mbs_only_flag", readBits(pSPSBytes, 1));

            if (spsMap.get("frame_mbs_only_flag") === 0) {
                spsMap.set("mb_adaptive_frame_field_flag", readBits(pSPSBytes, 1));
            }
            spsMap.set("direct_8x8_interence_flag", readBits(pSPSBytes, 1));
            spsMap.set("frame_cropping_flag", readBits(pSPSBytes, 1));
            if (spsMap.get("frame_cropping_flag") === 1) {
                spsMap.set("frame_cropping_rect_left_offset", ue(pSPSBytes, 0));
                spsMap.set("frame_cropping_rect_right_offset", ue(pSPSBytes, 0));
                spsMap.set("frame_cropping_rect_top_offset", ue(pSPSBytes, 0));
                spsMap.set("frame_cropping_rect_bottom_offset", ue(pSPSBytes, 0));
            }

            //vui parameters
            spsMap.set("vui_parameters_present_flag", readBits(pSPSBytes, 1));
            if (spsMap.get("vui_parameters_present_flag")) {
                vuiParameters(pSPSBytes);
            }

            //console.log("=========================SPS END=========================");


            return true;
        },
        getSizeInfo () {
            let SubWidthC = 0;
            let SubHeightC = 0;

            if (spsMap.get("chroma_format_idc") === 0) { //monochrome
                SubWidthC = SubHeightC = 0;
            } else if (spsMap.get("chroma_format_idc") === 1) { //4:2:0
                SubWidthC = SubHeightC = BITWISE2;
            } else if (spsMap.get("chroma_format_idc") === BITWISE2) { //4:2:2
                SubWidthC = BITWISE2;
                SubHeightC = 1;
            } else if (spsMap.get("chroma_format_idc") === BITWISE3) { //4:4:4
                if (spsMap.get("separate_colour_plane_flag") === 0) {
                    SubWidthC = SubHeightC = 1;
                } else if (spsMap.get("separate_colour_plane_flag") === 1) {
                    SubWidthC = SubHeightC = 0;
                }
            }

            let PicWidthInMbs = spsMap.get("pic_width_in_mbs_minus1") + 1;

            let PicHeightInMapUnits = spsMap.get("pic_height_in_map_units_minus1") + 1;
            let FrameHeightInMbs = (BITWISE2 - spsMap.get("frame_mbs_only_flag")) * PicHeightInMapUnits;

            let cropLeft = 0;
            let cropRight = 0;
            let cropTop = 0;
            let cropBottom = 0;

            if (spsMap.get("frame_cropping_flag") === 1) {
                cropLeft = spsMap.get("frame_cropping_rect_left_offset");
                cropRight = spsMap.get("frame_cropping_rect_right_offset");
                cropTop = spsMap.get("frame_cropping_rect_top_offset");
                cropBottom = spsMap.get("frame_cropping_rect_bottom_offset");
            }
            let decodeSize = (PicWidthInMbs * BITWISE16) * (FrameHeightInMbs * BITWISE16);
            let width = (PicWidthInMbs * BITWISE16) - (SubWidthC * (cropLeft + cropRight));
            let height = (FrameHeightInMbs * BITWISE16) -
                (SubHeightC * (BITWISE2 - spsMap.get("frame_mbs_only_flag")) * (cropTop + cropBottom));

            let sizeInfo = {
                'width': width,
                'height': height,
                'decodeSize': decodeSize,
            };

            return sizeInfo;
        },
        getSpsValue (key) {
            return spsMap.get(key);
        },
        getCodecInfo () {
            let profileIdc = spsMap.get("profile_idc").toString(BITWISE16);
            let profileCompatibility = spsMap.get("profile_compatibility") < BITWISE15 ?
                "0" + spsMap.get("profile_compatibility").toString(BITWISE16) :
                spsMap.get("profile_compatibility").toString(BITWISE16);

            let levelIdc = spsMap.get("level_idc").toString(BITWISE16);

            //console.log("getCodecInfo = " + (profile_idc + profile_compatibility + level_idc));
            return profileIdc + profileCompatibility + levelIdc;

        },

        getSpsMap() {
            return spsMap;
        },

        getFPS() {
            return fps;
        }
    }

    return new constructor();

    function getBit(base, offset) {
        let offsetData = offset;
        let vCurBytes = (vBitCount + offsetData) >> BITWISE3;
        offsetData = (vBitCount + offset) & BITWISE0x00000007;
        return (((base[(vCurBytes)])) >> (BITWISE0x7 - (offsetData & BITWISE0x7))) & 0x1;
    }

    function readBits(pBuf, vReadBits) {
        let vOffset = 0;
        let vTmp = 0,
            vTmp2 = 0;

        if (vReadBits === 1) {
            vTmp = getBit(pBuf, vOffset);
        } else {
            for (let i = 0; i < vReadBits; i++) {
                vTmp2 = getBit(pBuf, i);
                vTmp = (vTmp << 1) + vTmp2;
            }
        }

        vBitCount += vReadBits;
        return vTmp;
    }

    function ue(base, offset) {
        let zeros = 0,
            vTmp = 0,
            vReturn = 0;
        let vIdx = offset;
        do {
            vTmp = getBit(base, vIdx++);
            if (vTmp === 0) {
                zeros++;
            }
        } while (0 === vTmp);

        if (zeros === 0) {
            vBitCount += 1;
            return 0;
        }

        vReturn = 1 << zeros;

        for (let i = zeros - 1; i >= 0; i--, vIdx++) {
            vTmp = getBit(base, vIdx);
            vReturn |= vTmp << i;
        }

        let addBitCount = (zeros * BITWISE2) + 1;
        vBitCount += addBitCount;

        return (vReturn - 1);
    }

    function se(base, offset) {
        let vReturn = ue(base, offset);

        if (vReturn & 0x1) {
            return (vReturn + 1) / BITWISE2;
        } else {
            return -vReturn / BITWISE2;
        }
    }

    function hrdParameters(pSPSBytes) {
        spsMap.set("cpb_cnt_minus1", ue(pSPSBytes, 0));
        spsMap.set("bit_rate_scale", readBits(pSPSBytes, BITWISE4));
        spsMap.set("cpb_size_scale", readBits(pSPSBytes, BITWISE4));
        let cpdCntMinus1 = spsMap.get("cpb_cnt_minus1");
        let bitRateValueMinus1 = new Array(cpdCntMinus1);
        let cpbSizeValueMinus1 = new Array(cpdCntMinus1);
        let cbrFlag = new Array(cpdCntMinus1);
        //Todo: 原本为i <= cpdCntMinus1，运行到此处时直接停住，原因不明，改为<后正常
        for (let i = 0; i < cpdCntMinus1; i++) {
            bitRateValueMinus1[i] = ue(pSPSBytes, 0);
            cpbSizeValueMinus1[i] = ue(pSPSBytes, 0);
            cbrFlag[i] = readBits(pSPSBytes, 1);
        }
        spsMap.set("bit_rate_value_minus1", bitRateValueMinus1);
        spsMap.set("cpb_size_value_minus1", cpbSizeValueMinus1);
        spsMap.set("cbr_flag", cbrFlag);

        spsMap.set("initial_cpb_removal_delay_length_minus1", readBits(pSPSBytes, BITWISE4));
        spsMap.set("cpb_removal_delay_length_minus1", readBits(pSPSBytes, BITWISE4));
        spsMap.set("dpb_output_delay_length_minus1", readBits(pSPSBytes, BITWISE4));
        spsMap.set("time_offset_length", readBits(pSPSBytes, BITWISE4));
    }

    function vuiParameters(pSPSBytes) {
        spsMap.set("aspect_ratio_info_present_flag", readBits(pSPSBytes, 1));
        if (spsMap.get("aspect_ratio_info_present_flag")) {
            spsMap.set("aspect_ratio_idc", readBits(pSPSBytes, BITWISE8));
            //Extended_SAR
            if (spsMap.get("aspect_ratio_idc") === BITWISE255) {
                spsMap.set("sar_width", readBits(pSPSBytes, BITWISE16));
                spsMap.set("sar_height", readBits(pSPSBytes, BITWISE16));
            }
        }

        spsMap.set("overscan_info_present_flag", readBits(pSPSBytes, 1));
        if (spsMap.get("overscan_info_present_flag")) {
            spsMap.set("overscan_appropriate_flag", readBits(pSPSBytes, 1));
        }
        spsMap.set("video_signal_type_present_flag", readBits(pSPSBytes, 1));
        if (spsMap.get("video_signal_type_present_flag")) {
            spsMap.set("video_format", readBits(pSPSBytes, BITWISE3));
            spsMap.set("video_full_range_flag", readBits(pSPSBytes, 1));
            spsMap.set("colour_description_present_flag", readBits(pSPSBytes, 1));
            if (spsMap.get("colour_description_present_flag")) {
                spsMap.set("colour_primaries", readBits(pSPSBytes, BITWISE8));
                spsMap.set("transfer_characteristics", readBits(pSPSBytes, BITWISE8));
                spsMap.set("matrix_coefficients", readBits(pSPSBytes, BITWISE8));
            }
        }
        spsMap.set("chroma_loc_info_present_flag", readBits(pSPSBytes, 1));
        if (spsMap.get("chroma_loc_info_present_flag")) {
            spsMap.set("chroma_sample_loc_type_top_field", ue(pSPSBytes, 0));
            spsMap.set("chroma_sample_loc_type_bottom_field", ue(pSPSBytes, 0));
        }
        spsMap.set("timing_info_present_flag", readBits(pSPSBytes, 1));
        if (spsMap.get("timing_info_present_flag")) {
            spsMap.set("num_units_in_tick", readBits(pSPSBytes, BITWISE32));
            spsMap.set("time_scale", readBits(pSPSBytes, BITWISE32));
            spsMap.set("fixed_frame_rate_flag", readBits(pSPSBytes, 1));

            fps =  spsMap.get("time_scale") / spsMap.get("num_units_in_tick");
            if(spsMap.get("fixed_frame_rate_flag")) {
                fps = fps / 2;
            }
        }
        spsMap.set("nal_hrd_parameters_present_flag", readBits(pSPSBytes, 1));
        if (spsMap.get("nal_hrd_parameters_present_flag")) {
            hrdParameters(pSPSBytes);
        }
        spsMap.set("vcl_hrd_parameters_present_flag", readBits(pSPSBytes, 1));
        if (spsMap.get("vcl_hrd_parameters_present_flag")) {
            hrdParameters(pSPSBytes);
        }
        if (spsMap.get("nal_hrd_parameters_present_flag") ||
            spsMap.get("vcl_hrd_parameters_present_flag")) {
            spsMap.set("low_delay_hrd_flag", readBits(pSPSBytes, 1));
        }
        spsMap.set("pic_struct_present_flag", readBits(pSPSBytes, 1));
        spsMap.set("bitstream_restriction_flag", readBits(pSPSBytes, 1));
        if (spsMap.get("bitstream_restriction_flag")) {
            spsMap.set("motion_vectors_over_pic_boundaries_flag", readBits(pSPSBytes, 1));
            spsMap.set("max_bytes_per_pic_denom", ue(pSPSBytes, 0));
            spsMap.set("max_bits_per_mb_denom", ue(pSPSBytes, 0));
            spsMap.set("log2_max_mv_length_horizontal", ue(pSPSBytes, 0));
            spsMap.set("log2_max_mv_length_vertical", ue(pSPSBytes, 0));
            spsMap.set("max_num_reorder_frames", ue(pSPSBytes, 0));
            spsMap.set("max_dec_frame_buffering", ue(pSPSBytes, 0));
        }
    }
}



//export default H264SPSParser;
