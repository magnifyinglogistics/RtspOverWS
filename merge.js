class Player {
    constructor(option) {
        this.ws = null;
        this.options = option;
        this.events = {
            error: ()=>{}
        };
    }

    init() {
        //console.log('init');
        this.ws = new WebSocketServer(this.options);
        this.ws.init();
    }

    connect() {
        for(let i in this.events) {
            this.ws.setCallBack(i, this.events[i]);
        }
        this.ws.connect();
    }

    play() {
        //console.log('player')
    }

    pause() {
        //console.log('pause')
    }

    close() {
        this.ws.close();
        //console.log('close1')
    }

    /**
     * 绘制额外信息
     * @param obj
     */
    updateInfo(obj) {
        this.ws.updateInfo(obj);
    }

    /**
     * 自定义事件
     * 目前支持如下事件
     * [error] websocket连接失败
     * [noStream] 收不到码流
     *
     * @param event 事件名
     * @param callback 事件响应函数
     */
    on(event, callback) {
        this.events[event] = callback;
    }
}

export default Player;

//websocketServer.js
function WebSocketServer(options) {
    let videoElement = null;
    let canvasElement = null;
    let websocket = null;
    let wsURL = null;
    let rtspURL = null;
    let username = null;
    let password = null;
    let CSeq = 1;
    let IsDescribe = false; //RTSP响应报文中，describe时有两段，以'\r\n'分段
    let currentState = "Options";
    let describekey = false;
    let Authentication = '\r\n'; //认证，信令最后四个字节为'\r\n\r\n'，为补足，默认为'\r\n'
    let sessionID = '';
    let rtspSDPData = {};
    let SDPinfo = []; //SDP信息
    let setupSDPIndex = 0;
    let getParameterInterval = null; //保活
    let AACCodecInfo = null;

//RTP包处理相关
    let rtspinterleave = null;
    let RTPPacketTotalSize = 0;
    let rtpheader = null;
    let rtpPacketArray = null;

    let workerManager = null;
    let connectFailCallback = null;

    let lastStreamTime = null; //记录收到码流的时间
    let getStreamInterval = null;
    let noStreamCallback = null;

    const RTSP_INTERLEAVE_LENGTH = 4; //交织头占4个字节
    const RTSP_STATE = {
        OK: 200,
        UNAUTHORIZED: 401,
        NOTFOUND: 404,
        INVALID_RANGE: 457,
        NOTSERVICE: 503,
        DISCONNECT: 999
    };
    const SEND_GETPARM_INTERVAL = 20000; //保活时间

    function constructor({video, canvas, wsUrl, rtspUrl, user, pwd} = {options}) {
        videoElement = video;
        canvasElement = canvas;
        wsURL = wsUrl;
        rtspURL = rtspUrl;
        username = user;
        password = pwd;

    }

    constructor.prototype = {
        init() {
            workerManager = new WorkerManager();
            workerManager.init(videoElement,canvasElement);
        },
        connect() {
            websocket = new WebSocket(wsURL);
            websocket.binaryType = 'arraybuffer';
            websocket.onmessage = ReceiveMessage;
            websocket.onopen = () => {
                let option = StringToU8Array("OPTIONS " + rtspURL + " RTSP/1.0\r\nCSeq: " + CSeq + "\r\n\r\n");
                websocket.send(option);
                //console.log('websocket connect')
            };
            websocket.onerror = ()=> {
                if(connectFailCallback) {
                    connectFailCallback('websocket connect fail');
                }
            }
        },
        close() {
            clearInterval(getParameterInterval);
            clearInterval(getStreamInterval);
            SendRtspCommand(CommandConstructor("TEARDOWN", null));
            websocket.close();
            if(workerManager) {
                workerManager.terminate();
            }
        },
        setCallBack(event, callback) {
            switch (event) {
                case 'error':
                    connectFailCallback = ()=>{
                        callback();
                        this.close();
                    };
                    break;
                case 'noStream':
                    noStreamCallback = ()=>{
                        callback();
                        this.close();
                    };
                    break;
                default:
                    console.log('unsupport event');
            }
        },
        updateInfo(obj) {
            workerManager.updateInfo(obj);
        }
    };



    return new constructor(options);

    /**
     * websocket消息处理函数
     * @param event
     * @constructor
     */
    function ReceiveMessage(event) {
        let data = event.data;
        let receiveUint8 = new Uint8Array(data);
        let PreceiveUint8 = new Uint8Array(receiveUint8.length);
        PreceiveUint8.set(receiveUint8, 0);
        let dataLength = PreceiveUint8.length;
        // if(dataLength < 10) {
        //     //console.log(String.fromCharCode.apply(null, PreceiveUint8))
        // }
        while (dataLength > 0) {
            if (PreceiveUint8[0] != 36) {//非$符号表示RTSP
                //console.log(PreceiveUint8[0], PreceiveUint8[1], PreceiveUint8[2], PreceiveUint8[3], PreceiveUint8[4])
                //console.log(PreceiveUint8.length)
                let PreceiveMsg = String.fromCharCode.apply(null, PreceiveUint8);
                //console.log(PreceiveMsg)
                let rtspendpos = null;
                if (IsDescribe === true) {
                    rtspendpos = PreceiveMsg.lastIndexOf("\r\n");
                    IsDescribe = false
                } else {
                    rtspendpos = PreceiveMsg.search("\r\n\r\n");

                }
                let rtspstartpos = PreceiveMsg.search("RTSP");
                if (rtspstartpos !== -1) {
                    if (rtspendpos !== -1) {
                        let RTSPResArray = PreceiveUint8.subarray(rtspstartpos, rtspendpos + RTSP_INTERLEAVE_LENGTH);
                        PreceiveUint8 = PreceiveUint8.subarray(rtspendpos + RTSP_INTERLEAVE_LENGTH);
                        let receiveMsg = String.fromCharCode.apply(null, RTSPResArray);
                        RTSPResHandler(receiveMsg);
                        dataLength = PreceiveUint8.length;
                    } else {
                        dataLength = PreceiveUint8.length;
                        return
                    }
                } else {
                    PreceiveUint8 = new Uint8Array;
                    return
                }
            } else { //$表示RTP和RTCP
                //console.log('RTP开始');
                //console.log(PreceiveUint8.length)
                // if(PreceiveUint8.length == 4) {
                //    console.log(PreceiveUint8)
                // }
                lastStreamTime = Date.now();
                rtspinterleave = PreceiveUint8.subarray(0, RTSP_INTERLEAVE_LENGTH);
                //console.log(rtspinterleave)
                RTPPacketTotalSize = rtspinterleave[2] * 256 + rtspinterleave[3];
                if (RTPPacketTotalSize + RTSP_INTERLEAVE_LENGTH <= PreceiveUint8.length) {
                    rtpheader = PreceiveUint8.subarray(RTSP_INTERLEAVE_LENGTH, 16);
                    rtpPacketArray = PreceiveUint8.subarray(16, RTPPacketTotalSize + RTSP_INTERLEAVE_LENGTH);
                    //rtpCallback(rtspinterleave, rtpheader, rtpPacketArray);
                    workerManager.parseRtpData(rtspinterleave, rtpheader, rtpPacketArray);
                    PreceiveUint8 = PreceiveUint8.subarray(RTPPacketTotalSize + RTSP_INTERLEAVE_LENGTH);
                    //console.log('PreceiveUint8.length:  ' + PreceiveUint8.length)
                    dataLength = PreceiveUint8.length;
                } else {
                    dataLength = PreceiveUint8.length;
                    //console.count('11111111111')
                    //console.log(PreceiveUint8)
                    return
                }
            }
        }
    }

    /**
     * 将字符串转为arrayBuffer
     * @param string
     */
    function StringToU8Array(string) {
        CSeq++;
        //console.log(string)
        let stringLength = string.length;
        let outputUint8Array = new Uint8Array(new ArrayBuffer(stringLength));
        for (let i = 0; i < stringLength; i++) {
            outputUint8Array[i] = string.charCodeAt(i);
        }
        //console.log(outputUint8Array)
        return outputUint8Array;
        //return string;
    }

    /**
     * 处理收到的RTSP信令，解析后发送下一条
     * @param stringMessage
     * @constructor
     */
    function RTSPResHandler(stringMessage) {
        //console.log(stringMessage)
        //let seekPoint = stringMessage.search("CSeq: ") + 5;
        let rtspResponseMsg = parseRtsp(stringMessage);
//console.log(rtspResponseMsg)
        if (rtspResponseMsg.ResponseCode === RTSP_STATE.UNAUTHORIZED && Authentication === "\r\n") { //需要鉴权
            if(currentState === "Describe") {
                IsDescribe = false;
                describekey = false;
            }
            //console.log(rtspResponseMsg)
            SendRtspCommand(formDigest(rtspResponseMsg));
            Authentication = "\r\n";

        } else if (rtspResponseMsg.ResponseCode === RTSP_STATE.OK) { //服务器端返回成功
            switch (currentState) {
                case 'Options':
                    currentState = "Describe";
                    SendRtspCommand(CommandConstructor("DESCRIBE", null));
                    break;
                case "Describe":
                    rtspSDPData = parseDescribeResponse(stringMessage);
                    if (typeof rtspResponseMsg.ContentBase !== "undefined") {
                        rtspSDPData.ContentBase = rtspResponseMsg.ContentBase
                    }
                    //console.log(rtspSDPData.Sessions)
                    for (let idx = 0; idx < rtspSDPData.Sessions.length; idx++) {
                        let sdpInfoObj = {};
                        if (rtspSDPData.Sessions[idx].CodecMime === "H264" ) { //暂时只支持H264
                            sdpInfoObj.codecName = rtspSDPData.Sessions[idx].CodecMime;
                            sdpInfoObj.trackID = rtspSDPData.Sessions[idx].ControlURL;
                            sdpInfoObj.ClockFreq = rtspSDPData.Sessions[idx].ClockFreq;
                            sdpInfoObj.Port = parseInt(rtspSDPData.Sessions[idx].Port);
                            if (typeof rtspSDPData.Sessions[idx].Framerate !== "undefined") {
                                sdpInfoObj.Framerate = parseInt(rtspSDPData.Sessions[idx].Framerate)
                            }
                            if(typeof rtspSDPData.Sessions[idx].SPS !== "undefined") {
                                sdpInfoObj.SPS = rtspSDPData.Sessions[idx].SPS;
                            }
                            SDPinfo.push(sdpInfoObj)
                        } else {
                            console.log("Unknown codec type:", rtspSDPData.Sessions[idx].CodecMime, rtspSDPData.Sessions[idx].ControlURL)
                        }
                    }
                    setupSDPIndex = 0;
                    currentState = "Setup";
                    //console.log(SDPinfo[setupSDPIndex])
                    SendRtspCommand(CommandConstructor("SETUP", SDPinfo[setupSDPIndex].trackID, setupSDPIndex));
                    //SendRtspCommand(CommandConstructor("SETUP", 'track1'));
                    break;
                case "Setup":
                    sessionID = rtspResponseMsg.SessionID;
                    //多路流(如音频流)
                    //在Describe中暂时只解析H264视频流，因此SDPinfo.length始终为1
                    if (setupSDPIndex < SDPinfo.length) {
                        SDPinfo[setupSDPIndex].RtpInterlevedID = rtspResponseMsg.RtpInterlevedID;
                        SDPinfo[setupSDPIndex].RtcpInterlevedID = rtspResponseMsg.RtcpInterlevedID;
                        setupSDPIndex += 1;
                        if (setupSDPIndex !== SDPinfo.length) {
                            SendRtspCommand(CommandConstructor("SETUP", SDPinfo[setupSDPIndex].trackID, setupSDPIndex));
                        } else {
                            workerManager.sendSdpInfo(SDPinfo);
                            currentState = "Play";
                            SendRtspCommand(CommandConstructor("PLAY"));
                        }
                    }

                    sessionID = rtspResponseMsg.SessionID;
                    //开始播放后，发送GET_PARAMETER进行保活
                    clearInterval(getParameterInterval);
                    getParameterInterval = setInterval(function () {
                        SendRtspCommand(CommandConstructor("GET_PARAMETER", null))
                    }, SEND_GETPARM_INTERVAL);

                    getStreamInterval = setInterval(()=>{
                        if(!getBitStream()) {
                            console.log('超时！');
                            noStreamCallback && noStreamCallback();
                        }
                    }, 5000);
                    break;
                case "Play":

                    break;
                default:
                    console.log('暂不支持的信令');
                    break;
            }
        } else if (rtspResponseMsg.ResponseCode === RTSP_STATE.NOTSERVICE) { //服务不可用

        } else if (rtspResponseMsg.ResponseCode === RTSP_STATE.NOTFOUND) { //Not Found

        }
    }

    /**
     * 发送rtsp信令
     * @param sendMessage
     * @constructor
     */
    function SendRtspCommand(sendMessage) {
        //console.log(sendMessage)
        if (websocket !== null && websocket.readyState === WebSocket.OPEN) {
            if (describekey === false) {
                let describeCmd = sendMessage.search("DESCRIBE");
                if (describeCmd !== -1) {
                    IsDescribe = true;
                    describekey = true;
                }
            }
            //console.log(sendMessage)
            websocket.send(StringToU8Array(sendMessage))
        } else {
            console.log('websocket未连接')
        }
    }

    /**
     * 组装RTSP信令
     * @param method
     * @param trackID
     * @returns {*}
     * @constructor
     */
    function CommandConstructor(method, trackID, interleaved) {
        let sendMessage;
        switch (method) {
            case"OPTIONS":
            case"TEARDOWN":
            case"SET_PARAMETERS":
            case"DESCRIBE":
                //TODO: 保活
                sendMessage = method + " " + rtspURL + " RTSP/1.0\r\nCSeq: " + CSeq + "\r\n" + Authentication;
                break;
            case"SETUP":
                //console.log(trackID)
                //TODO 多trackID的时候测试一下
                sendMessage = method + " " + rtspURL + "/" + trackID + " RTSP/1.0\r\nCSeq: " + CSeq + Authentication + "Transport:RTP/AVP/TCP;unicast;interleaved=" + 2 * interleaved + "-" + (2 * interleaved + 1) + "\r\n";
                if(sessionID == 0) {
                    sendMessage += "\r\n";
                } else {
                    sendMessage += "Session: " + sessionID + "\r\n\r\n";
                }
                break;
            case"PLAY":
                sendMessage = method + " " + rtspURL + " RTSP/1.0\r\nCSeq: " + CSeq + "\r\nSession: " + sessionID + "\r\n" + "Range: npt=0.000-\r\n" + Authentication;
                break;
            case"PAUSE":
                sendMessage = method + " " + rtspURL + " RTSP/1.0\r\nCSeq: " + CSeq + "\r\nSession: " + sessionID + "\r\n\r\n";
                break;
            case"GET_PARAMETER":
                sendMessage = method + " " + rtspURL + " RTSP/1.0\r\nCSeq: " + CSeq + "\r\nSession: " + sessionID + "\r\n"  + Authentication;
                break;
            default:
                console.log('暂不支持的RTSP信令');
        }
        //console.log(sendMessage);
        return sendMessage;
    }

    /**
     * 解析RTSP信令
     * @param message1
     */
    function parseRtsp(message1) {
        let RtspResponseData = {};
        let cnt = 0, cnt1 = 0, ttt = null, LineTokens = null;
        let message = null;
        if (message1.search("Content-Type: application/sdp") !== -1) {
            let messageTok = message1.split("\r\n\r\n");
            message = messageTok[0]
        } else {
            message = message1
        }
        let TokenziedResponseLines = message.split("\r\n");
        let ResponseCodeTokens = TokenziedResponseLines[0].split(" ");
        if (ResponseCodeTokens.length > 2) {
            RtspResponseData.ResponseCode = parseInt(ResponseCodeTokens[1]);
            RtspResponseData.ResponseMessage = ResponseCodeTokens[2]
        }
        if (RtspResponseData.ResponseCode === RTSP_STATE.OK) {
            for (cnt = 1; cnt < TokenziedResponseLines.length; cnt++) {
                LineTokens = TokenziedResponseLines[cnt].split(":");
                if (LineTokens[0] === "Public") {
                    RtspResponseData.MethodsSupported = LineTokens[1].split(",")
                } else if (LineTokens[0] === "CSeq") {
                    RtspResponseData.CSeq = parseInt(LineTokens[1])
                } else if (LineTokens[0] === "Content-Type") {
                    RtspResponseData.ContentType = LineTokens[1];
                    if (RtspResponseData.ContentType.search("application/sdp") !== -1) {
                        RtspResponseData.SDPData = parseDescribeResponse(message1)
                    }
                } else if (LineTokens[0] === "Content-Length") {
                    RtspResponseData.ContentLength = parseInt(LineTokens[1])
                } else if (LineTokens[0] === "Content-Base") {
                    let ppos = TokenziedResponseLines[cnt].search("Content-Base:");
                    if (ppos !== -1) {
                        RtspResponseData.ContentBase = TokenziedResponseLines[cnt].substr(ppos + 13)
                    }
                } else if (LineTokens[0] === "Session") {
                    let SessionTokens = LineTokens[1].split(";");
                    //RtspResponseData.SessionID = parseInt(SessionTokens[0])
                    //console.log(SessionTokens[0])
                    RtspResponseData.SessionID = SessionTokens[0].trim();
                } else if (LineTokens[0] === "Transport") {
                    let TransportTokens = LineTokens[1].split(";");
                    for (cnt1 = 0; cnt1 < TransportTokens.length; cnt1++) {
                        let tpos = TransportTokens[cnt1].search("interleaved=");
                        if (tpos !== -1) {
                            let interleaved = TransportTokens[cnt1].substr(tpos + 12);
                            let interleavedTokens = interleaved.split("-");
                            if (interleavedTokens.length > 1) {
                                RtspResponseData.RtpInterlevedID = parseInt(interleavedTokens[0]);
                                RtspResponseData.RtcpInterlevedID = parseInt(interleavedTokens[1])
                            }
                        }
                    }
                } else if (LineTokens[0] === "RTP-Info") {
                    LineTokens[1] = TokenziedResponseLines[cnt].substr(9);
                    let RTPInfoTokens = LineTokens[1].split(",");
                    RtspResponseData.RTPInfoList = [];
                    for (cnt1 = 0; cnt1 < RTPInfoTokens.length; cnt1++) {
                        let RtpTokens = RTPInfoTokens[cnt1].split(";");
                        let RtpInfo = {};
                        for (let cnt2 = 0; cnt2 < RtpTokens.length; cnt2++) {
                            let poss = RtpTokens[cnt2].search("url=");
                            if (poss !== -1) {
                                RtpInfo.URL = RtpTokens[cnt2].substr(poss + 4)
                            }
                            poss = RtpTokens[cnt2].search("seq=");
                            if (poss !== -1) {
                                RtpInfo.Seq = parseInt(RtpTokens[cnt2].substr(poss + 4))
                            }
                        }
                        RtspResponseData.RTPInfoList.push(RtpInfo)
                    }
                }
            }
        } else if (RtspResponseData.ResponseCode === RTSP_STATE.UNAUTHORIZED) {
            for (cnt = 1; cnt < TokenziedResponseLines.length; cnt++) {
                LineTokens = TokenziedResponseLines[cnt].split(":");
                if (LineTokens[0] === "CSeq") {
                    RtspResponseData.CSeq = parseInt(LineTokens[1])
                } else if (LineTokens[0] === "WWW-Authenticate") {
                    let AuthTokens = LineTokens[1].split(",");
                    for (cnt1 = 0; cnt1 < AuthTokens.length; cnt1++) {
                        let pos = AuthTokens[cnt1].search("Digest realm=");
                        if (pos !== -1) {
                            ttt = AuthTokens[cnt1].substr(pos + 13);
                            let realmtok = ttt.split('"');
                            RtspResponseData.Realm = realmtok[1]
                        }
                        pos = AuthTokens[cnt1].search("nonce=");
                        if (pos !== -1) {
                            ttt = AuthTokens[cnt1].substr(pos + 6);
                            let noncetok = ttt.split('"');
                            RtspResponseData.Nonce = noncetok[1]
                        }
                    }
                }
            }
        }
        return RtspResponseData
    }

    /**
     * 解析Describe信令
     * @param message1
     */
    function parseDescribeResponse(message1) {
        //console.log(message1)
        let SDPData = {};
        let Sessions = [];
        SDPData.Sessions = Sessions;
        let message = null;
        if (message1.search("Content-Type: application/sdp") !== -1) {
            let messageTok = message1.split("\r\n\r\n");
            message = messageTok[1]
        } else {
            message = message1
        }
        let TokenziedDescribe = message.split("\r\n");
        let mediaFound = false;
        for (let cnt = 0; cnt < TokenziedDescribe.length; cnt++) {
            let SDPLineTokens = TokenziedDescribe[cnt].split("=");
            if (SDPLineTokens.length > 0) {
                switch (SDPLineTokens[0]) {
                    case"a":
                        let aLineToken = SDPLineTokens[1].split(":");
                        if (aLineToken.length > 1) {
                            if (aLineToken[0] === "control") {
                                let pos = TokenziedDescribe[cnt].search("control:");
                                if (mediaFound === true) {
                                    if (pos !== -1) {
                                        SDPData.Sessions[SDPData.Sessions.length - 1].ControlURL = TokenziedDescribe[cnt].substr(pos + 8)
                                    }
                                } else {
                                    if (pos !== -1) {
                                        SDPData.BaseURL = TokenziedDescribe[cnt].substr(pos + 8)
                                    }
                                }
                            } else if (aLineToken[0] === "rtpmap") {
                                //console.log(aLineToken)
                                let rtpmapLine = aLineToken[1].split(" ");
                                //console.log(rtpmapLine)
                                SDPData.Sessions[SDPData.Sessions.length - 1].PayloadType = rtpmapLine[0];
                                let MimeLine = rtpmapLine[1].split("/");
                                SDPData.Sessions[SDPData.Sessions.length - 1].CodecMime = MimeLine[0];
                                if (MimeLine.length > 1) {
                                    SDPData.Sessions[SDPData.Sessions.length - 1].ClockFreq = MimeLine[1]
                                }
                            } else if (aLineToken[0] === "framesize") {
                                let framesizeLine = aLineToken[1].split(" ");
                                if (framesizeLine.length > 1) {
                                    let framesizeinf = framesizeLine[1].split("-");
                                    SDPData.Sessions[SDPData.Sessions.length - 1].Width = framesizeinf[0];
                                    SDPData.Sessions[SDPData.Sessions.length - 1].Height = framesizeinf[1]
                                }
                            } else if (aLineToken[0] === "framerate") {
                                SDPData.Sessions[SDPData.Sessions.length - 1].Framerate = aLineToken[1]
                            } else if (aLineToken[0] === "fmtp") {
                                let sessLine = TokenziedDescribe[cnt].split(" ");
                                if (sessLine.length < 2) {
                                    continue
                                }
                                for (let ii = 1; ii < sessLine.length; ii++) {
                                    let sessToken = sessLine[ii].split(";");
                                    let sessprmcnt = 0;
                                    for (sessprmcnt = 0; sessprmcnt < sessToken.length; sessprmcnt++) {
                                        let ppos = sessToken[sessprmcnt].search("mode=");
                                        if (ppos !== -1) {
                                            SDPData.Sessions[SDPData.Sessions.length - 1].mode = sessToken[sessprmcnt].substr(ppos + 5)
                                        }
                                        ppos = sessToken[sessprmcnt].search("config=");
                                        if (ppos !== -1) {
                                            SDPData.Sessions[SDPData.Sessions.length - 1].config = sessToken[sessprmcnt].substr(ppos + 7);
                                            AACCodecInfo.config = SDPData.Sessions[SDPData.Sessions.length - 1].config;
                                            AACCodecInfo.clockFreq = SDPData.Sessions[SDPData.Sessions.length - 1].ClockFreq;
                                            AACCodecInfo.bitrate = SDPData.Sessions[SDPData.Sessions.length - 1].Bitrate
                                        }
                                        ppos = sessToken[sessprmcnt].search("sprop-vps=");
                                        if (ppos !== -1) {
                                            SDPData.Sessions[SDPData.Sessions.length - 1].VPS = sessToken[sessprmcnt].substr(ppos + 10)
                                        }
                                        ppos = sessToken[sessprmcnt].search("sprop-sps=");
                                        if (ppos !== -1) {
                                            SDPData.Sessions[SDPData.Sessions.length - 1].SPS = sessToken[sessprmcnt].substr(ppos + 10)
                                        }
                                        ppos = sessToken[sessprmcnt].search("sprop-pps=");
                                        if (ppos !== -1) {
                                            SDPData.Sessions[SDPData.Sessions.length - 1].PPS = sessToken[sessprmcnt].substr(ppos + 10)
                                        }
                                        ppos = sessToken[sessprmcnt].search("sprop-parameter-sets=");
                                        if (ppos !== -1) {
                                            let SPSPPS = sessToken[sessprmcnt].substr(ppos + 21);
                                            let SPSPPSTokenized = SPSPPS.split(",");
                                            if (SPSPPSTokenized.length > 1) {
                                                SDPData.Sessions[SDPData.Sessions.length - 1].SPS = SPSPPSTokenized[0];
                                                SDPData.Sessions[SDPData.Sessions.length - 1].PPS = SPSPPSTokenized[1]
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        break;
                    case"m":
                        let mLineToken = SDPLineTokens[1].split(" ");
                        let Session = {};
                        Session.Type = mLineToken[0];
                        Session.Port = mLineToken[1];
                        Session.Payload = mLineToken[3];
                        SDPData.Sessions.push(Session);
                        mediaFound = true;
                        break;
                    case"b":
                        if (mediaFound === true) {
                            let bLineToken = SDPLineTokens[1].split(":");
                            SDPData.Sessions[SDPData.Sessions.length - 1].Bitrate = bLineToken[1]
                        }
                        break
                }
            }
        }
        return SDPData
    };

    function formDigest(message) {
        let {Nonce, Realm} = message;
        //Realm = '54c415830ec4';
        //Nonce = 'fb01c51948704e59eb5a474b33caff8b';
        let user = {
            username: username,
            password: password,
        }
        let hex1 = hex_md5(user.username + ":" + Realm + ":" + user.password);
        let hex2 = hex_md5(currentState.toUpperCase() + ":" + rtspURL);
        let responce = hex_md5(hex1 + ":" + Nonce + ":" + hex2);
        Authentication = 'Authorization: Digest username="' + user.username + '", realm="' + Realm + '", nonce="' + Nonce + '",uri="' + rtspURL + '", response="' + responce + '"\r\n' + "Accept: application/sdp\r\n" + '\r\n';

        return  currentState.toUpperCase() + " " + rtspURL + " RTSP/1.0\r\nCSeq: " + CSeq + "\r\n" + Authentication;
    }


    function getBitStream() {
        if(lastStreamTime === null) {
            lastStreamTime = Date.now();
        } else {
            //console.log(Date.now() - lastStreamTime)
            return Date.now() - lastStreamTime < 5000;
        }
    }
}

//md5.js
/*
 * A JavaScript implementation of the RSA Data Security, Inc. MD5 Message
 * Digest Algorithm, as defined in RFC 1321.
 * Version 2.1 Copyright (C) Paul Johnston 1999 - 2002.
 * Other contributors: Greg Holt, Andrew Kepert, Ydnar, Lostinet
 * Distributed under the BSD License
 * See http://pajhome.org.uk/crypt/md5 for more info.
 */

/*
 * Configurable variables. You may need to tweak these to be compatible with
 * the server-side, but the defaults work in most cases.
 */
var hexcase = 0;  /* hex output format. 0 - lowercase; 1 - uppercase        */
var b64pad  = ""; /* base-64 pad character. "=" for strict RFC compliance   */
var chrsz   = 8;  /* bits per input character. 8 - ASCII; 16 - Unicode      */

/*
 * These are the functions you'll usually want to call
 * They take string arguments and return either hex or base-64 encoded strings
 */
function hex_md5(s){ return binl2hex(core_md5(str2binl(s), s.length * chrsz));}
function b64_md5(s){ return binl2b64(core_md5(str2binl(s), s.length * chrsz));}
function str_md5(s){ return binl2str(core_md5(str2binl(s), s.length * chrsz));}
function hex_hmac_md5(key, data) { return binl2hex(core_hmac_md5(key, data)); }
function b64_hmac_md5(key, data) { return binl2b64(core_hmac_md5(key, data)); }
function str_hmac_md5(key, data) { return binl2str(core_hmac_md5(key, data)); }

/*
 * Perform a simple self-test to see if the VM is working
 */
function md5_vm_test()
{
  return hex_md5("abc") == "900150983cd24fb0d6963f7d28e17f72";
}

/*
 * Calculate the MD5 of an array of little-endian words, and a bit length
 */
function core_md5(x, len)
{
  /* append padding */
  x[len >> 5] |= 0x80 << ((len) % 32);
  x[(((len + 64) >>> 9) << 4) + 14] = len;

  var a =  1732584193;
  var b = -271733879;
  var c = -1732584194;
  var d =  271733878;

  for(var i = 0; i < x.length; i += 16)
  {
    var olda = a;
    var oldb = b;
    var oldc = c;
    var oldd = d;

    a = md5_ff(a, b, c, d, x[i+ 0], 7 , -680876936);
    d = md5_ff(d, a, b, c, x[i+ 1], 12, -389564586);
    c = md5_ff(c, d, a, b, x[i+ 2], 17,  606105819);
    b = md5_ff(b, c, d, a, x[i+ 3], 22, -1044525330);
    a = md5_ff(a, b, c, d, x[i+ 4], 7 , -176418897);
    d = md5_ff(d, a, b, c, x[i+ 5], 12,  1200080426);
    c = md5_ff(c, d, a, b, x[i+ 6], 17, -1473231341);
    b = md5_ff(b, c, d, a, x[i+ 7], 22, -45705983);
    a = md5_ff(a, b, c, d, x[i+ 8], 7 ,  1770035416);
    d = md5_ff(d, a, b, c, x[i+ 9], 12, -1958414417);
    c = md5_ff(c, d, a, b, x[i+10], 17, -42063);
    b = md5_ff(b, c, d, a, x[i+11], 22, -1990404162);
    a = md5_ff(a, b, c, d, x[i+12], 7 ,  1804603682);
    d = md5_ff(d, a, b, c, x[i+13], 12, -40341101);
    c = md5_ff(c, d, a, b, x[i+14], 17, -1502002290);
    b = md5_ff(b, c, d, a, x[i+15], 22,  1236535329);

    a = md5_gg(a, b, c, d, x[i+ 1], 5 , -165796510);
    d = md5_gg(d, a, b, c, x[i+ 6], 9 , -1069501632);
    c = md5_gg(c, d, a, b, x[i+11], 14,  643717713);
    b = md5_gg(b, c, d, a, x[i+ 0], 20, -373897302);
    a = md5_gg(a, b, c, d, x[i+ 5], 5 , -701558691);
    d = md5_gg(d, a, b, c, x[i+10], 9 ,  38016083);
    c = md5_gg(c, d, a, b, x[i+15], 14, -660478335);
    b = md5_gg(b, c, d, a, x[i+ 4], 20, -405537848);
    a = md5_gg(a, b, c, d, x[i+ 9], 5 ,  568446438);
    d = md5_gg(d, a, b, c, x[i+14], 9 , -1019803690);
    c = md5_gg(c, d, a, b, x[i+ 3], 14, -187363961);
    b = md5_gg(b, c, d, a, x[i+ 8], 20,  1163531501);
    a = md5_gg(a, b, c, d, x[i+13], 5 , -1444681467);
    d = md5_gg(d, a, b, c, x[i+ 2], 9 , -51403784);
    c = md5_gg(c, d, a, b, x[i+ 7], 14,  1735328473);
    b = md5_gg(b, c, d, a, x[i+12], 20, -1926607734);

    a = md5_hh(a, b, c, d, x[i+ 5], 4 , -378558);
    d = md5_hh(d, a, b, c, x[i+ 8], 11, -2022574463);
    c = md5_hh(c, d, a, b, x[i+11], 16,  1839030562);
    b = md5_hh(b, c, d, a, x[i+14], 23, -35309556);
    a = md5_hh(a, b, c, d, x[i+ 1], 4 , -1530992060);
    d = md5_hh(d, a, b, c, x[i+ 4], 11,  1272893353);
    c = md5_hh(c, d, a, b, x[i+ 7], 16, -155497632);
    b = md5_hh(b, c, d, a, x[i+10], 23, -1094730640);
    a = md5_hh(a, b, c, d, x[i+13], 4 ,  681279174);
    d = md5_hh(d, a, b, c, x[i+ 0], 11, -358537222);
    c = md5_hh(c, d, a, b, x[i+ 3], 16, -722521979);
    b = md5_hh(b, c, d, a, x[i+ 6], 23,  76029189);
    a = md5_hh(a, b, c, d, x[i+ 9], 4 , -640364487);
    d = md5_hh(d, a, b, c, x[i+12], 11, -421815835);
    c = md5_hh(c, d, a, b, x[i+15], 16,  530742520);
    b = md5_hh(b, c, d, a, x[i+ 2], 23, -995338651);

    a = md5_ii(a, b, c, d, x[i+ 0], 6 , -198630844);
    d = md5_ii(d, a, b, c, x[i+ 7], 10,  1126891415);
    c = md5_ii(c, d, a, b, x[i+14], 15, -1416354905);
    b = md5_ii(b, c, d, a, x[i+ 5], 21, -57434055);
    a = md5_ii(a, b, c, d, x[i+12], 6 ,  1700485571);
    d = md5_ii(d, a, b, c, x[i+ 3], 10, -1894986606);
    c = md5_ii(c, d, a, b, x[i+10], 15, -1051523);
    b = md5_ii(b, c, d, a, x[i+ 1], 21, -2054922799);
    a = md5_ii(a, b, c, d, x[i+ 8], 6 ,  1873313359);
    d = md5_ii(d, a, b, c, x[i+15], 10, -30611744);
    c = md5_ii(c, d, a, b, x[i+ 6], 15, -1560198380);
    b = md5_ii(b, c, d, a, x[i+13], 21,  1309151649);
    a = md5_ii(a, b, c, d, x[i+ 4], 6 , -145523070);
    d = md5_ii(d, a, b, c, x[i+11], 10, -1120210379);
    c = md5_ii(c, d, a, b, x[i+ 2], 15,  718787259);
    b = md5_ii(b, c, d, a, x[i+ 9], 21, -343485551);

    a = safe_add(a, olda);
    b = safe_add(b, oldb);
    c = safe_add(c, oldc);
    d = safe_add(d, oldd);
  }
  return Array(a, b, c, d);

}

/*
 * These functions implement the four basic operations the algorithm uses.
 */
function md5_cmn(q, a, b, x, s, t)
{
  return safe_add(bit_rol(safe_add(safe_add(a, q), safe_add(x, t)), s),b);
}
function md5_ff(a, b, c, d, x, s, t)
{
  return md5_cmn((b & c) | ((~b) & d), a, b, x, s, t);
}
function md5_gg(a, b, c, d, x, s, t)
{
  return md5_cmn((b & d) | (c & (~d)), a, b, x, s, t);
}
function md5_hh(a, b, c, d, x, s, t)
{
  return md5_cmn(b ^ c ^ d, a, b, x, s, t);
}
function md5_ii(a, b, c, d, x, s, t)
{
  return md5_cmn(c ^ (b | (~d)), a, b, x, s, t);
}

/*
 * Calculate the HMAC-MD5, of a key and some data
 */
function core_hmac_md5(key, data)
{
  var bkey = str2binl(key);
  if(bkey.length > 16) bkey = core_md5(bkey, key.length * chrsz);

  var ipad = Array(16), opad = Array(16);
  for(var i = 0; i < 16; i++)
  {
    ipad[i] = bkey[i] ^ 0x36363636;
    opad[i] = bkey[i] ^ 0x5C5C5C5C;
  }

  var hash = core_md5(ipad.concat(str2binl(data)), 512 + data.length * chrsz);
  return core_md5(opad.concat(hash), 512 + 128);
}

/*
 * Add integers, wrapping at 2^32. This uses 16-bit operations internally
 * to work around bugs in some JS interpreters.
 */
function safe_add(x, y)
{
  var lsw = (x & 0xFFFF) + (y & 0xFFFF);
  var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
  return (msw << 16) | (lsw & 0xFFFF);
}

/*
 * Bitwise rotate a 32-bit number to the left.
 */
function bit_rol(num, cnt)
{
  return (num << cnt) | (num >>> (32 - cnt));
}

/*
 * Convert a string to an array of little-endian words
 * If chrsz is ASCII, characters >255 have their hi-byte silently ignored.
 */
function str2binl(str)
{
  var bin = Array();
  var mask = (1 << chrsz) - 1;
  for(var i = 0; i < str.length * chrsz; i += chrsz)
    bin[i>>5] |= (str.charCodeAt(i / chrsz) & mask) << (i%32);
  return bin;
}

/*
 * Convert an array of little-endian words to a string
 */
function binl2str(bin)
{
  var str = "";
  var mask = (1 << chrsz) - 1;
  for(var i = 0; i < bin.length * 32; i += chrsz)
    str += String.fromCharCode((bin[i>>5] >>> (i % 32)) & mask);
  return str;
}

/*
 * Convert an array of little-endian words to a hex string.
 */
function binl2hex(binarray)
{
  var hex_tab = hexcase ? "0123456789ABCDEF" : "0123456789abcdef";
  var str = "";
  for(var i = 0; i < binarray.length * 4; i++)
  {
    str += hex_tab.charAt((binarray[i>>2] >> ((i%4)*8+4)) & 0xF) +
           hex_tab.charAt((binarray[i>>2] >> ((i%4)*8  )) & 0xF);
  }
  return str;
}

/*
 * Convert an array of little-endian words to a base-64 string
 */
function binl2b64(binarray)
{
  var tab = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var str = "";
  for(var i = 0; i < binarray.length * 4; i += 3)
  {
    var triplet = (((binarray[i   >> 2] >> 8 * ( i   %4)) & 0xFF) << 16)
                | (((binarray[i+1 >> 2] >> 8 * ((i+1)%4)) & 0xFF) << 8 )
                |  ((binarray[i+2 >> 2] >> 8 * ((i+2)%4)) & 0xFF);
    for(var j = 0; j < 4; j++)
    {
      if(i * 8 + j * 6 > binarray.length * 32) str += b64pad;
      else str += tab.charAt((triplet >> 6*(3-j)) & 0x3F);
    }
  }
  return str;
}


//workerManager.js
function WorkerManager() {
    let videoWorker;
    let SDPInfo;
    let messageArray = [];
    let rtpStackCount = 0;
    let videoElement = null;
    let canvasElement = null;
    let videoMS = null;

    const rtpStackCheckNum = 10;

    let codecInfo = null;
    let initSegmentData = null;
    let mediaInfo = {
        id: 1,
        samples: null,
        baseMediaDecodeTime: 0
    };
    let numBox = 1;
    let mediaSegNum = 0; //用于记录缓存的box个数
    let mediaFrameData = null; //用于缓存未喂入mse的box
    let mediaFrameSize = 0; //mediaFrameData的大小
    let preBaseDecodeTime = 0; //上一个解码时间
    let curBaseDecodeTime = 0; //从第一帧到当前帧的持续时间
    let mediaSegmentData = null; //MP4化的数据
    let sequenseNum = 1;

    let mp4Remux;

    let firstTimeStamp = null; //第一个视频帧的时间戳
    let SEIinfo = null;
    let ivsDrawer = null;
    let info = null;
    let MAX_INFO = 25; // 限制info最大长度
    let startDrawIVS = false;
    let lastTime = 0;
    function constructor() {

    }

    constructor.prototype = {
        init(video,canvas) {

// Build a worker from an anonymous function body
var blobURL = URL.createObjectURL( new Blob([ '(',

function(){
    //Long-running work here
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
    
//H264SPSParser.js
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
//H264Session.js
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




//export default H264SPSParser;

}.toString(),

')()' ], { type: 'application/javascript' } ) );

videoWorker = new Worker( blobURL );

// Won't be needing this anymore
URL.revokeObjectURL( blobURL );


            videoWorker.onmessage = videoWorkerMessage;
            videoElement = video;
            canvasElement = canvas;

            mp4Remux = new MP4Remux();
            mp4Remux.init();

            SEIinfo = new IVSQueue();
            info = new LruCache(MAX_INFO);
            ivsDrawer = new IvsDrawer(canvasElement);
        },

        sendSdpInfo(SDPinfo) {
            SDPInfo = SDPinfo;
            //console.log(SDPinfo)
            let message = {
                type: "sdpInfo",
                data: {
                    sdpInfo: SDPInfo
                }
            };
            videoWorker.postMessage(message);
        },

        parseRtpData(rtspinterleave, rtpheader, rtpPacketArray) {
            // console.log(rtspinterleave)
            // console.log( rtpheader)
            // //console.log(rtpPacketArray)
            // console.log(rtpheader[3])

            let mediaType = rtspinterleave[1];
            let idx = parseInt(mediaType / 2, 10);
            let markerBitHex = 128;
            let message = {
                type: "rtpData",
                data: {rtspInterleave: rtspinterleave, header: rtpheader, payload: rtpPacketArray}
            };
            //console.log(rtspinterleave)
            //console.log('idx: ',idx)

            if(idx !== 0) {
                console.log('idx: ',rtspinterleave);
                //console.log(SDPInfo)
                return;
            }
            switch (SDPInfo[idx].codecName) {
                case"H264":
                    messageArray.push(message);
                    if (rtpStackCount >= rtpStackCheckNum || (rtpheader[1] & markerBitHex) === markerBitHex) {
                        if((rtpheader[1] & markerBitHex) === markerBitHex) {
                            //onsole.log('遇到终止位: ' + rtpheader[1])
                        }
                        let sendMessage = {type: "rtpDataArray", data: messageArray};
                        if (videoWorker) {
                            videoWorker.postMessage(sendMessage)
                        }
                        sendMessage = null;
                        messageArray = [];
                        rtpStackCount = 0
                        //console.log('1111111111')
                    } else {
                        rtpStackCount++
                    }
                    break;
                default:
            }
        },

        /**
         * 更新需要绘制的其它信息
         * @param obj
         */
        updateInfo(obj) {
            info.set(obj.id, obj.name);
        },

        terminate() {
            videoWorker.terminate();
            ivsDrawer.terminate();
            info.clear();
            startDrawIVS = false;
            window.onresize = null;
            if(videoMS) {
                videoMS.close();
                videoMS = null;
            }
        }
    }

    return new constructor();

    function videoWorkerMessage(event) {
        let videoMessage = event.data;
        let type = videoMessage.type;
        //console.log(videoMessage.data)
        switch (type) {
            // case 'codecInfo': //设置codecType
            //     break;
            // case 'initSegment': //第一个buffer，设置SPS等
            case 'videoInit'://合并codecInfo和initSegment
                console.log(videoMessage)
                codecInfo = videoMessage.data.codecInfo;
                //console.log(videoMessage.data)
                initSegmentData = mp4Remux.initSegment(videoMessage.data.initSegmentData);
//console.log(initSegmentData)
                videoMS = new VideoMediaSource(videoElement);
                videoMS.CodecInfo = codecInfo;
                videoMS.InitSegment = initSegmentData;
                //console.log(videoMS.CodecInfo, videoMS.InitSegment)
                videoMS.init();
                videoMS.onCanplayCallback(()=>{ivsDrawer.cover(videoElement)});

                windowResizeEvent(()=>{ivsDrawer.cover(videoElement)});
                break;
            case 'firstvideoTimeStamp':
                firstTimeStamp = videoMessage.data;

                videoMS.setFirstTimeStamp(firstTimeStamp);
                //videoMS.setDurationChangeCallBack(drawIVS);

                console.log('first frame timestamp: ', firstTimeStamp);
                startDrawIVS = true;
                window.requestAnimationFrame(()=>{
                    draw();
                })
                break;
            case 'videoTimeStamp'://时间戳，用于智能同步
                //videoMS.setFirstTimeStamp(videoMessage.data);
                //console.log('frame timestamp: ', videoMessage.data);
                //console.log('npt: ', ( videoMessage.data - firstTimeStamp)/90000)
                break;
            case 'mediaSample': //用于设置baseMediaDecodeTime
                if(mediaInfo.samples == null) {
                    mediaInfo.samples = new Array(numBox);
                }
                //console.log('frameDuration: ' + videoMessage.data.frameDuration)
                curBaseDecodeTime += videoMessage.data.frameDuration;

                mediaInfo.samples[mediaSegNum++] = videoMessage.data;
                break;
            case 'videoRender': //视频数据
                //缓存该segment数据
                let tempBuffer = new Uint8Array(videoMessage.data.length + mediaFrameSize);
                if(mediaFrameSize !== 0) {
                    tempBuffer.set(mediaFrameData);
                }
                //console.log(videoMessage)
                tempBuffer.set(videoMessage.data, mediaFrameSize);
                mediaFrameData = tempBuffer;
                mediaFrameSize = mediaFrameData.length;

                if(mediaSegNum % numBox === 0 && mediaSegNum !== 0) {
                    if (sequenseNum === 1) {
                        mediaInfo.baseMediaDecodeTime = 0
                    } else {
                        mediaInfo.baseMediaDecodeTime = preBaseDecodeTime;
                    }
                    preBaseDecodeTime = curBaseDecodeTime;

//console.log(mediaInfo);
                    mediaSegmentData = mp4Remux.mediaSegment(sequenseNum, mediaInfo, mediaFrameData);
                    sequenseNum++;
                    mediaSegNum = 0;
                    mediaFrameData = null;
                    mediaFrameSize = 0;

                    if (videoMS !== null) {
                        //console.log(mediaSegmentData)
                        videoMS.setMediaSegment(mediaSegmentData)
                    } else {

                    }
                }
                break;
            case 'YUVData'://FFMPEG解码的数据
                //console.log(videoMessage.data)
                //draw(videoMessage.data);
                //yuv2canvas(videoMessage.data.data, videoMessage.data.width, videoMessage.data.height,canvasElement)

                break;
            case 'SEI': //处理SEI信息
                //console.log('SEI timestamp: ', videoMessage.data.timestamp);
                //console.log('SEI-npt: ', (videoMessage.data.timestamp - firstTimeStamp)/90000)
                if(videoMessage.data.ivs !== null) {
                    let ivs = [];
                    videoMessage.data.ivs.map((content, k) => {
                        if(content.state) { //state=1, 绘制该信息
                            ivs.push(content);
                        }else { //state=0, 清除info中对应的id:name
                            // let id = content.id;
                            // console.log('删除', id, info[id]);
                            // delete info[id];
                            // console.log(info)
                        }
                    });

                    //console.log('SEI: ', videoMessage.data.timestamp)
                    SEIinfo.push(videoMessage.data.timestamp, ivs);

                    //console.log(videoMessage.data.timestamp - lastTime)
                    //lastTime = videoMessage.data.timestamp;
                }
                //console.log('timestamp: ', videoMessage.data.timestamp)
                //console.log(SEIinfo)
                break;
            default:
                console.log('暂不支持其他类型');
                break;
        }
    }

    function draw() {
        let timestamp = videoElement.currentTime * 90000 + firstTimeStamp + 3600;//
        drawIVS(timestamp);
        if(startDrawIVS) {
            window.requestAnimationFrame(()=>{draw()});
        }
    }

    /**
     * 根据时间戳获取相应的ivs信息
     * @param timestamp 当前帧的时间戳
     * @returns {*} ivs信息
     */
    function getIVS(timestamp) {
        let preNode = null;
        let nextNode = null;
        preNode = SEIinfo.shift();
        nextNode = SEIinfo.top();
        while((preNode !== undefined) && (preNode !== null)) {
            if(preNode[0] > timestamp) {
                SEIinfo.unshift(preNode);
                //console.log('SEI时间大于video: ', preNode[0], timestamp);
                return null;
            } else if(preNode[0] === timestamp) {
                return preNode[1];
            } else {

                if(nextNode === undefined || nextNode === null) {
                    console.log('last ivs info: ', timestamp, preNode[0], SEIinfo);
                    if(SEIinfo.length()) {
                        SEIinfo.map((v, k)=>{
                            console.log(v);
                        });
                    }
                    return preNode[1];//最后一个node
                }
                if(nextNode[0] > timestamp) {
                    return preNode[1];
                } else if(nextNode[0] === timestamp){
                    nextNode = SEIinfo.shift();
                    return nextNode[1];
                } else {
                    preNode = SEIinfo.shift();
                    nextNode = SEIinfo.top();
                }
            }
        }
        return null;
    }

    /**
     * 绘制智能信息
     * @param timestamp
     */
    function drawIVS(timestamp) {
        //return null;
        let data = getIVS(timestamp);
        // //
        if(data === undefined || data === null) {
            //清空画布
            if(!SEIinfo.length()) {
                ivsDrawer.clearCanvas();
            }
        }else {
            //console.log(info.map.length)
            if(info.map.length > MAX_INFO) {
                console.log('info length: ', info.map.length);
            }

            //获取鹰眼信息
            data.map((content, k) =>{
                let result = info.get(content.id);
                if(result !== undefined && result !== null) {
                    data[k].text = result.value;
                }
            });

            ivsDrawer.draw(data, timestamp);
        }
    }
}


function windowResizeEvent(callback) {
    window.onresize = function() {
        let target = this;
        if (target.resizeFlag) {
            clearTimeout(target.resizeFlag);
        }

        target.resizeFlag = setTimeout(function() {
            callback();
            target.resizeFlag = null;
        }, 100);
    }
}

function yuv2canvas(yuv, width, height, canvas) {

    canvas.width = width;
    canvas.height = height;

    var context    = canvas.getContext("2d");
    var output     = context.createImageData(width, height);
    var outputData = output.data;

    var yOffset = 0;
    var uOffset = width * height;
    var vOffset = width * height + (width*height)/4;
    for (var h=0; h<height; h++) {
        for (var w=0; w<width; w++) {
            var ypos = w + h * width + yOffset;

            var upos = (w>>1) + (h>>1) * width/2 + uOffset;
            var vpos = (w>>1) + (h>>1) * width/2 + vOffset;

            var Y = yuv[ypos];
            var U = yuv[upos] - 128;
            var V = yuv[vpos] - 128;

            var R =  (Y + 1.371*V);
            var G =  (Y - 0.698*V - 0.336*U);
            var B =  (Y + 1.732*U);

            var outputData_pos = w*4 + width*h*4;
            outputData[0+outputData_pos] = R;
            outputData[1+outputData_pos] = G;
            outputData[2+outputData_pos] = B;
            outputData[3+outputData_pos] = 255;
        }
    }

    context.putImageData(output, 0, 0);
}

class IVSQueue {

    constructor() {
        this.list = [];
    }

    push(timestamp, ivs) {
        this.list.push([timestamp, ivs]);
    }

    shift() {
        let tmp = this.list.shift();
        return tmp;
    }

    unshift(node) {
        this.list.unshift(node);
    }

    top() {

        let tmp = this.list[0];
        return tmp;
    }

    length() {
        return this.list.length;
    }

    map(v,k) {
        return this.list.map(v,k);
    }
}

class LruCache {
    constructor(limit) {
        this.limit = limit || 20;
        this.map = [];
    }
    get(key) {
        return this._search(key);
    }
    set(key, value) {
        let result  = this._search(key);
        if(!result) {
            this.map.unshift({
                key: key,
                value: value
            });
            if(this.map.length > this.limit) {
                this.map.pop();
            }
        }
    }

    //每次查找将该元素置于队首
    _search(key) {
        for(let i = 0, length = this.map.length; i < length; i++) {
            if(this.map[i].key === key) {
                let head = this.map.splice(i, 1);
                this.map.unshift(head[0]);
                return head[0];
            }
        }
        return null;
    }

    clear() {
        this.map = [];
    }
}

//VideoMediaSource.js
function VideoMediaSource(element) {
    let videoElement = null;
    let codecInfo = null;

    let mediaSource = null;
    let sourceBuffer = null;

    let initSegmentData = null;

    let ctrlDelayFlag = false;
    let delay = 0.5;
    let waitingCount = 0;
    let time = 0;

    let segmentWaitDecode = [];

    let firstTimeStamp = null;
    let isFirstTimeStamp = false;


    let onDurationChangeCallback = null;
    let onCanplayCallback = null;

    function constructor(element) {
        videoElement = element;
    }

    constructor.prototype = {
        init() {
            videoElement.controls = false;
            videoElement.autoplay = "autoplay";
            //videoElement.preload = "auto";
            videoElement.muted = true;

            addVideoEventListener(videoElement);

            appendInitSegment();
        },

        setMediaSegment(mediaSegment) {
            appendNextMediaSegment(mediaSegment)
        },

        setFirstTimeStamp(time) {
            if(!isFirstTimeStamp) {
                console.log('set firstTimeStamp:', time)
                firstTimeStamp = time;
                isFirstTimeStamp = true;
            }
        },

        setDurationChangeCallBack(callback) {
            onDurationChangeCallback = callback;
        },

        set CodecInfo(CodecInfo) {
            codecInfo = CodecInfo;
        },

        get CodecInfo() {
            return codecInfo;
        },

        set InitSegment(data) {
            initSegmentData = data;
        },

        get InitSegment() {
            return initSegmentData;
        },

        onCanplayCallback(callback) {
            onCanplayCallback = callback;
        },

        close() {
            videoElement.pause();
            removeEventListener();
            mediaSource.removeSourceBuffer(sourceBuffer);
            mediaSource.endOfStream();
            sourceBuffer = null;
            mediaSource = null;
            videoElement = null;
        }
    }

    return new constructor(element);

    function appendInitSegment() {
        if(mediaSource == null || mediaSource.readyState === 'end') {
            mediaSource = new MediaSource();
            addMediaSourceEventListener(mediaSource);
            videoElement.src = window.URL.createObjectURL(mediaSource);
            //console.log('new MediaSource');
            return;
        }

        //console.log('appendInitSegment start');
        if(mediaSource.sourceBuffers.length === 0) {
            mediaSource.duration = 0;
            let codecs = 'video/mp4;codecs="avc1.' + codecInfo + '"';
            if(!MediaSource.isTypeSupported(codecs)) {
                //console.log('要播放视频格式 video/mp4;codecs="avc1.64002a", video/mp4;codecs="avc1.64002a"，您还需要安装一个额外的微软组件，参见 https://support.mozilla.org/kb/fix-video-audio-problems-firefox-windows')
                console.log('not support ' + codecs)
                return;
            }
            sourceBuffer = mediaSource.addSourceBuffer(codecs);
            addSourceBufferEventListener(sourceBuffer);
        }

        let initSegment = initSegmentData;
        if(initSegment == null) {
            mediaSource.endOfStream();
            console.log('no initSegmentData');
        }
        //console.log(sourceBuffer)
        sourceBuffer.appendBuffer(initSegment);
        //console.log(sourceBuffer)
        // saveAs(new File(initSegment, "test"));
        //  Savesegments.set(initSegment, 0);
        //  segmentsLength += initSegment.length;
        //  segmentsNum --;
        console.log('appendInitSegment end')
    }

    function appendNextMediaSegment(mediaData) {

        if(sourceBuffer == null) {
            segmentWaitDecode.push(mediaData);
            return;
        }
        //console.log(mediaSource.readyState, mediaSource.readyState,sourceBuffer.updating)
        if(mediaSource.readyState === 'closed' || mediaSource.readyState === "ended") {
            console.log('mediaSource closed or ended')
            return;
        }

        if(onDurationChangeCallback) {
            //90000为采样率，先写死
            let rtpTimestamp = videoElement.currentTime * 90000 + firstTimeStamp + 3600;
            //console.log('callback time: ', rtpTimestamp)
            //console.log('sourceBuffer: ', sourceBuffer.timestampOffset)
            onDurationChangeCallback(rtpTimestamp);
        }

        //console.count('一帧');

        //try {
        if(segmentWaitDecode.length) {
            segmentWaitDecode.push(mediaData);
            //console.log(segmentWaitDecode)
        }else {
            if(!sourceBuffer.updating) {
                sourceBuffer.appendBuffer(mediaData);
            } else {
                segmentWaitDecode.push(mediaData);
            }
        }
        //}catch (e){
        //    console.log('appendNextMediaSegment Error')
        //}



        //console.log(sourceBuffer)
    }

    /**
     * Video事件
     * @param videoElement video对象
     */
    function addVideoEventListener(videoElement) {
        videoElement.addEventListener('loadstart', onloadstart);

        videoElement.addEventListener('waiting', onWaiting);

        videoElement.addEventListener('durationchange', onDurationChange);

        videoElement.addEventListener('timeupdate', timeupdate);

        videoElement.addEventListener('canplay', oncanplay);

        videoElement.addEventListener('canplaythrough', oncanplaythrough);

        videoElement.addEventListener('error', onVideoError);
    }

    function onloadstart() {
        console.log('loadstart');
    }

    function onDurationChange() {
        //console.log('durationchange');
        if (mediaSource === null) {
            return
        }

        //console.log('currentTime：', videoElement.currentTime);
        // if(onDurationChangeCallback) {
        //     //90000为采样率，先写死
        //     let rtpTimestamp = videoElement.currentTime * 90000 + firstTimeStamp ;
        //     //console.log('callback time: ', rtpTimestamp)
        //     onDurationChangeCallback(rtpTimestamp);
        // }

        //try {
        if(sourceBuffer && sourceBuffer.buffered && sourceBuffer.buffered.length > 0) {
            checkBuffer();
            //console.log('end: ',sourceBuffer.buffered.end(0))
            if(ctrlDelayFlag) {
                let startTime = sourceBuffer.buffered.start(0);
                let endTime = sourceBuffer.buffered.end(0);
                let diffTime = videoElement.currentTime === 0 ? endTime - startTime: endTime - videoElement.currentTime
                if(diffTime >= delay + 0.1) {
                    if(sourceBuffer.updating) {
                        return;
                    }
                    let tempCurrntTime = endTime - delay;
                    console.log('跳秒前', videoElement.currentTime)
                    videoElement.currentTime = tempCurrntTime.toFixed(3);
                    console.log('跳秒后', videoElement.currentTime)
                    //ctrlDelayFlag = false;
                }
            }
        }
        //}catch(e) {
        //    console.log('sourceBuffer has been moved')
        //}

    }

    function timeupdate() {
        // console.log('******timeupdate******');
        // console.log(videoElement.currentTime);
        // console.log('******timeupdate end******')
    }

    function oncanplay() {
        // if(isFirstTimeStamp && (firstTimeStamp == null)) {
        //     //firstTimeStamp =
        //     isFirstTimeStamp = false;
        // }

        onCanplayCallback && onCanplayCallback(videoElement);
        console.log('canplay');
    }

    function oncanplaythrough() {
        ctrlDelayFlag = true;
        console.log('canplaythrough');
    }

    function onVideoError() {
        console.log('error');
        //console.log(e)
        console.log(videoElement.currentTime)
    }


    /**
     * MediaSource事件
     * @param mediaSource
     */
    function addMediaSourceEventListener(mediaSource) {
        mediaSource.addEventListener('sourceopen', onSourceOpen);

        mediaSource.addEventListener('error', onMediaSourceError);
    }

    function onSourceOpen() {
        console.log('OnsourceOpen');
        appendInitSegment(); //此处重新调用一次，是为了建立sourceBuffer
    }

    function onMediaSourceError() {
        console.log('mediaSource error');
        console.log(videoElement.currentTime)
    }

    /**
     * sourceBuffer事件
     */
    function addSourceBufferEventListener(sourceBuffer) {
        sourceBuffer.addEventListener('error', onSourceBufferError);

        sourceBuffer.addEventListener('update', onUpdate);
    }

    function onSourceBufferError() {
        console.log('sourceBuffer Error');
        console.log(videoElement.currentTime)
    }

    function onUpdate() {
        //console.log('sourceBuffer update');
        if(segmentWaitDecode.length > 0) {
            if(!sourceBuffer.updating) {
                sourceBuffer.appendBuffer(segmentWaitDecode[0]);

                //console.log('segmentWaitDecode:  ' + segmentWaitDecode.length)
                segmentWaitDecode.shift();
            }
        }
        //console.log(e)
    }

    function checkBuffer() {
        let minute = 20;
        let bufferTime = 10;
        let startTime = sourceBuffer.buffered.start(0);
        let endTime = sourceBuffer.buffered.end(0);
        if (!sourceBuffer.updating && (endTime - startTime > minute)) {
            sourceBuffer.remove(startTime, endTime - bufferTime)
        }else if(sourceBuffer.updating && (endTime - startTime > minute)) {
            console.log('clear buffer failed!')
        }
    }

    function onWaiting() {
        console.log('waiting....')
        ctrlDelayFlag = false;

        if(delay < 1.5) {
            if(waitingCount === 0) {
                time = Date.now();
                waitingCount++;
            }else {
                waitingCount++;
                if((Date.now() - time) <= 60000 && waitingCount >= 5) {
                    delay += 0.1;
                    console.log('delay: ', delay);
                    time = Date.now();
                    waitingCount = 0;
                }
            }
        }
    }

    function removeEventListener() {
        videoElement.removeEventListener('loadstart', onloadstart);
        videoElement.removeEventListener('waiting', onWaiting);
        videoElement.removeEventListener('durationchange', onDurationChange);
        videoElement.removeEventListener('timeupdate', timeupdate);
        videoElement.removeEventListener('canplay', oncanplay);
        videoElement.removeEventListener('canplaythrough', oncanplaythrough);
        videoElement.removeEventListener('error', onVideoError);

        mediaSource.removeEventListener('sourceopen', onSourceOpen);
        mediaSource.removeEventListener('error', onMediaSourceError);

        sourceBuffer.removeEventListener('error', onSourceBufferError);
        sourceBuffer.removeEventListener('update', onUpdate);
    }

}

//MP4Remux.js
let _dtsBase;
let _types = [];
let datas = {};

_types = {
    avc1: [], avcC: [], btrt: [], dinf: [],
    dref: [], esds: [], ftyp: [], hdlr: [],
    mdat: [], mdhd: [], mdia: [], mfhd: [],
    minf: [], moof: [], moov: [], mp4a: [],
    mvex: [], mvhd: [], sdtp: [], stbl: [],
    stco: [], stsc: [], stsd: [], stsz: [],
    stts: [], tfdt: [], tfhd: [], traf: [],
    trak: [], trun: [], trex: [], tkhd: [],
    vmhd: [], smhd: []
};

class MP4Remux {
    constructor() {

    }

    init() {
        for (let name in _types) {
            _types[name] = [
                name.charCodeAt(0),
                name.charCodeAt(1),
                name.charCodeAt(2),
                name.charCodeAt(3)
            ];
        }

        _dtsBase = 0;

        datas.FTYP = new Uint8Array([
            0x69, 0x73, 0x6F, 0x6D, // major_brand: isom
            0x0, 0x0, 0x0, 0x1,  // minor_version: 0x01
            0x69, 0x73, 0x6F, 0x6D, // isom
            0x61, 0x76, 0x63, 0x31  // avc1
        ]);

        datas.STSD_PREFIX = new Uint8Array([
            0x00, 0x00, 0x00, 0x00, // version(0) + flags
            0x00, 0x00, 0x00, 0x01  // entry_count
        ]);

        datas.STTS = new Uint8Array([
            0x00, 0x00, 0x00, 0x00, // version(0) + flags
            0x00, 0x00, 0x00, 0x00  // entry_count
        ]);

        datas.STSC = datas.STCO = datas.STTS;

        datas.STSZ = new Uint8Array([
            0x00, 0x00, 0x00, 0x00, // version(0) + flags
            0x00, 0x00, 0x00, 0x00, // sample_size
            0x00, 0x00, 0x00, 0x00  // sample_count
        ]);

        datas.HDLR_VIDEO = new Uint8Array([
            0x00, 0x00, 0x00, 0x00, // version(0) + flags
            0x00, 0x00, 0x00, 0x00, // pre_defined
            0x76, 0x69, 0x64, 0x65, // handler_type: 'vide'
            0x00, 0x00, 0x00, 0x00, // reserved: 3 * 4 bytes
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x56, 0x69, 0x64, 0x65,
            0x6F, 0x48, 0x61, 0x6E,
            0x64, 0x6C, 0x65, 0x72, 0x00 // name: VideoHandler
        ]);

        datas.HDLR_AUDIO = new Uint8Array([
            0x00, 0x00, 0x00, 0x00, // version(0) + flags
            0x00, 0x00, 0x00, 0x00, // pre_defined
            0x73, 0x6F, 0x75, 0x6E, // handler_type: 'soun'
            0x00, 0x00, 0x00, 0x00, // reserved: 3 * 4 bytes
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x53, 0x6F, 0x75, 0x6E,
            0x64, 0x48, 0x61, 0x6E,
            0x64, 0x6C, 0x65, 0x72, 0x00 // name: SoundHandler
        ]);

        datas.DREF = new Uint8Array([
            0x00, 0x00, 0x00, 0x00, // version(0) + flags
            0x00, 0x00, 0x00, 0x01, // entry_count
            0x00, 0x00, 0x00, 0x0C, // entry_size
            0x75, 0x72, 0x6C, 0x20, // type 'url '
            0x00, 0x00, 0x00, 0x01  // version(0) + flags
        ]);

        // Sound media header
        datas.SMHD = new Uint8Array([
            0x00, 0x00, 0x00, 0x00, // version(0) + flags
            0x00, 0x00, 0x00, 0x00  // balance(2) + reserved(2)
        ]);

        // video media header
        datas.VMHD = new Uint8Array([
            0x00, 0x00, 0x00, 0x01, // version(0) + flags
            0x00, 0x00,             // graphicsmode: 2 bytes
            0x00, 0x00, 0x00, 0x00, // opcolor: 3 * 2 bytes
            0x00, 0x00
        ]);
    }

    initSegment(meta) {
        let ftyp = box(_types.ftyp, datas.FTYP);
        let moov = Moov(meta);
        let seg = new Uint8Array(ftyp.byteLength + moov.byteLength);
        seg.set(ftyp, 0);
        seg.set(moov, ftyp.byteLength);
        return seg;
    }

    mediaSegment(sequenceNumber, track, data) {
        let moof = Moof(sequenceNumber, track);
        let frameData = mdat(data);
        let seg = new Uint8Array(moof.byteLength + frameData.byteLength);
        seg.set(moof, 0);
        seg.set(frameData, moof.byteLength);
        return seg
    }
}

//组装initSegment

function Moov(meta) {
    let mvhd = Mvhd(meta.timescale, meta.duration);
    let trak = Trak(meta);
    let mvex = Mvex(meta);

    return box(_types.moov, mvhd, trak, mvex);
}

//组装moov
function Mvhd(timescale, duration) {
    return box(_types.mvhd, new Uint8Array([
        0x00, 0x00, 0x00, 0x00,    // version(0) + flags
        0x00, 0x00, 0x00, 0x00,    // creation_time
        0x00, 0x00, 0x00, 0x00,    // modification_time
        (timescale >>> 24) & 0xFF, // timescale: 4 bytes
        (timescale >>> 16) & 0xFF,
        (timescale >>>  8) & 0xFF,
        (timescale) & 0xFF,
        (duration >>> 24) & 0xFF,  // duration: 4 bytes
        (duration >>> 16) & 0xFF,
        (duration >>>  8) & 0xFF,
        (duration) & 0xFF,
        0x00, 0x01, 0x00, 0x00,    // Preferred rate: 1.0
        0x01, 0x00, 0x00, 0x00,    // PreferredVolume(1.0, 2bytes) + reserved(2bytes)
        0x00, 0x00, 0x00, 0x00,    // reserved: 4 + 4 bytes
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00,    // ----begin composition matrix----
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x40, 0x00, 0x00, 0x00,    // ----end composition matrix----
        0x00, 0x00, 0x00, 0x00,    // ----begin pre_defined 6 * 4 bytes----
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,    // ----end pre_defined 6 * 4 bytes----
        0xFF, 0xFF, 0xFF, 0xFF     // next_track_ID
    ]));
}

function Trak(meta) {
    return box(_types.trak, Tkhd(meta), Mdia(meta));
}

function Mvex(meta) {
    return box(_types.mvex, trex(meta));
}

//组装trak
function Tkhd(meta) {
    let trackId = meta.id;
    let duration = meta.duration;
    let width = meta.width;
    let height = meta.height;

    return box(_types.tkhd, new Uint8Array([
        0x00, 0x00, 0x00, 0x07,   // version(0) + flags
        0x00, 0x00, 0x00, 0x00,   // creation_time
        0x00, 0x00, 0x00, 0x00,   // modification_time
        (trackId >>> 24) & 0xFF,  // track_ID: 4 bytes
        (trackId >>> 16) & 0xFF,
        (trackId >>>  8) & 0xFF,
        (trackId) & 0xFF,
        0x00, 0x00, 0x00, 0x00,   // reserved: 4 bytes
        (duration >>> 24) & 0xFF, // duration: 4 bytes
        (duration >>> 16) & 0xFF,
        (duration >>>  8) & 0xFF,
        (duration) & 0xFF,
        0x00, 0x00, 0x00, 0x00,   // reserved: 2 * 4 bytes
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,   // layer(2bytes) + alternate_group(2bytes)
        0x00, 0x00, 0x00, 0x00,   // volume(2bytes) + reserved(2bytes)
        0x00, 0x01, 0x00, 0x00,   // ----begin composition matrix----
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x40, 0x00, 0x00, 0x00,   // ----end composition matrix----
        (width >>> 8) & 0xFF,     // width and height
        (width) & 0xFF,
        0x00, 0x00,
        (height >>> 8) & 0xFF,
        (height) & 0xFF,
        0x00, 0x00
    ]));
}

function Mdia(meta) {
    return box(_types.mdia, mdhd(meta), hdlr(meta), minf(meta));
}

//组装mdia
function mdhd(meta) {
    let timescale = meta.timescale;
    let duration = meta.duration;

    return box(_types.mdhd, new Uint8Array([
        0x00, 0x00, 0x00, 0x00,    // version(0) + flags
        0x00, 0x00, 0x00, 0x00,    // creation_time
        0x00, 0x00, 0x00, 0x00,    // modification_time
        (timescale >>> 24) & 0xFF, // timescale: 4 bytes
        (timescale >>> 16) & 0xFF,
        (timescale >>>  8) & 0xFF,
        (timescale) & 0xFF,
        (duration >>> 24) & 0xFF,  // duration: 4 bytes
        (duration >>> 16) & 0xFF,
        (duration >>>  8) & 0xFF,
        (duration) & 0xFF,
        0x55, 0xC4,                // language: und (undetermined)
        0x00, 0x00                 // pre_defined = 0
    ]));
}

function hdlr(meta) {
    let data = null;

    if (meta.type === 'audio') {
        data = datas.HDLR_AUDIO;
    } else {
        data = datas.HDLR_VIDEO;
    }

    return box(_types.hdlr, data);
}

function minf(meta) {
    let xmhd = null;

    if (meta.type === 'audio') {
        xmhd = box(_types.smhd, datas.SMHD);
    } else {
        xmhd = box(_types.vmhd, datas.VMHD);
    }

    return box(_types.minf, xmhd, dinf(), stbl(meta));
}

//组装minf
function dinf() {
    return box(_types.dinf, box(_types.dref, datas.DREF));
}

function stbl(meta) {
    let result = box(_types.stbl,   // type: stbl
        stsd(meta),                   // Sample Description Table
        box(_types.stts, datas.STTS), // Time-To-Sample
        box(_types.stsc, datas.STSC), // Sample-To-Chunk
        box(_types.stsz, datas.STSZ), // Sample size
        box(_types.stco, datas.STCO)  // Chunk offset
    );

    return result;
}

//组装stbl
function stsd(meta) {
    if (meta.type === 'audio') {
        return box(_types.stsd, datas.STSD_PREFIX, mp4a(meta));
    } else {
        return box(_types.stsd, datas.STSD_PREFIX, avc1(meta));
    }
}

//组装stsd
function mp4a(meta) {
    let channelCount = meta.channelCount;
    let sampleRate = meta.audioSampleRate;

    let data = new Uint8Array([
        0x00, 0x00, 0x00, 0x00,    // reserved(4)
        0x00, 0x00, 0x00, 0x01,    // reserved(2) + data_reference_index(2)
        0x00, 0x00, 0x00, 0x00,    // reserved: 2 * 4 bytes
        0x00, 0x00, 0x00, 0x00,
        0x00, channelCount,        // channelCount(2)
        0x00, 0x10,                // sampleSize(2)
        0x00, 0x00, 0x00, 0x00,    // reserved(4)
        (sampleRate >>> 8) & 0xFF, // Audio sample rate
        (sampleRate) & 0xFF,
        0x00, 0x00
    ]);

    return box(_types.mp4a, data, esds(meta));
}

function avc1(meta) {
    let width = meta.width;
    let height = meta.height;

    let sps = meta.sps || [], pps = meta.pps || [], sequenceParameterSets = [], pictureParameterSets = [];
    for (let i = 0; i < sps.length; i++) {
        sequenceParameterSets.push((sps[i].byteLength & 65280) >>> 8);
        sequenceParameterSets.push(sps[i].byteLength & 255);
        sequenceParameterSets = sequenceParameterSets.concat(Array.prototype.slice.call(sps[i]))
    }
    for (let i = 0; i < pps.length; i++) {
        pictureParameterSets.push((pps[i].byteLength & 65280) >>> 8);
        pictureParameterSets.push(pps[i].byteLength & 255);
        pictureParameterSets = pictureParameterSets.concat(Array.prototype.slice.call(pps[i]))
    }

    //Todo: 待测，如果视频有问题，修改这里
    // let data = new Uint8Array([
    //     0x00, 0x00, 0x00, 0x00, // reserved(4)
    //     0x00, 0x00, 0x00, 0x01, // reserved(2) + data_reference_index(2)
    //     0x00, 0x00, 0x00, 0x00, // pre_defined(2) + reserved(2)
    //     0x00, 0x00, 0x00, 0x00, // pre_defined: 3 * 4 bytes
    //     0x00, 0x00, 0x00, 0x00,
    //     0x00, 0x00, 0x00, 0x00,
    //     (width >>> 8) & 0xFF,   // width: 2 bytes
    //     (width) & 0xFF,
    //     (height >>> 8) & 0xFF,  // height: 2 bytes
    //     (height) & 0xFF,
    //     0x00, 0x48, 0x00, 0x00, // horizresolution: 4 bytes
    //     0x00, 0x48, 0x00, 0x00, // vertresolution: 4 bytes
    //     0x00, 0x00, 0x00, 0x00, // reserved: 4 bytes
    //     0x00, 0x01,             // frame_count
    //     0x0A,                   // strlen
    //     0x78, 0x71, 0x71, 0x2F, // compressorname: 32 bytes
    //     0x66, 0x6C, 0x76, 0x2E,
    //     0x6A, 0x73, 0x00, 0x00,
    //     0x00, 0x00, 0x00, 0x00,
    //     0x00, 0x00, 0x00, 0x00,
    //     0x00, 0x00, 0x00, 0x00,
    //     0x00, 0x00, 0x00, 0x00,
    //     0x00, 0x00, 0x00,
    //     0x00, 0x18,             // depth
    //     0xFF, 0xFF              // pre_defined = -1
    // ]);

    let data = new Uint8Array(
        [0, 0, 0, 0,
            0, 0, 0, 1,
            0, 0, 0, 0,
            0, 0, 0, 0,
            0, 0, 0, 0,
            0, 0, 0, 0,
            (65280 & width) >> 8,
            255 & width,
            (65280 & height) >> 8,
            255 & height,
            0, 72, 0, 0,
            0, 72, 0, 0,
            0, 0, 0, 0,
            0, 1, 19, 0,
            0, 0, 0, 0,
            0, 0, 0, 0,
            0, 0, 0, 0,
            0, 0, 0, 0,
            0, 0, 0, 0,
            0, 0, 0, 0,
            0, 0, 0, 0,
            0, 0, 0, 24, 17, 17]);

    return box(_types.avc1, data, box(_types.avcC, new Uint8Array([1, meta.profileIdc, meta.profileCompatibility, meta.levelIdc, 255].concat([sps.length]).concat(sequenceParameterSets).concat([pps.length]).concat(pictureParameterSets))));
}

//组装mp4a
function esds(meta) {
    let config = meta.config;
    let configSize = config.length;
    let data = new Uint8Array([
        0x00, 0x00, 0x00, 0x00, // version 0 + flags

        0x03,                   // descriptor_type
        0x17 + configSize,      // length3
        0x00, 0x01,             // es_id
        0x00,                   // stream_priority

        0x04,                   // descriptor_type
        0x0F + configSize,      // length
        0x40,                   // codec: mpeg4_audio
        0x15,                   // stream_type: Audio
        0x00, 0x00, 0x00,       // buffer_size
        0x00, 0x00, 0x00, 0x00, // maxBitrate
        0x00, 0x00, 0x00, 0x00, // avgBitrate

        0x05                    // descriptor_type
    ].concat(
        [configSize]
    ).concat(
        config
    ).concat(
        [0x06, 0x01, 0x02]      // GASpecificConfig
    ));

    return box(_types.esds, data);
}

//组装mvex
function trex(meta) {
    var trackId = meta.id;
    var data = new Uint8Array([
        0x00, 0x00, 0x00, 0x00,  // version(0) + flags
        (trackId >>> 24) & 0xFF, // track_ID
        (trackId >>> 16) & 0xFF,
        (trackId >>>  8) & 0xFF,
        (trackId) & 0xFF,
        0x00, 0x00, 0x00, 0x01,  // default_sample_description_index
        0x00, 0x00, 0x00, 0x00,  // default_sample_duration
        0x00, 0x00, 0x00, 0x00,  // default_sample_size
        0x00, 0x01, 0x00, 0x01   // default_sample_flags
    ]);

    return box(_types.trex, data);
}

//组装mediaSegment
function Moof(sequenceNumber, track) {
    return box(_types.moof, mfhd(sequenceNumber), traf(track));
}

function mdat(data) {
    return box(_types.mdat, data);
}

//组装moof
function mfhd(sequenceNumber) {
    var data = new Uint8Array([
        0x00, 0x00, 0x00, 0x00,
        (sequenceNumber >>> 24) & 0xFF, // sequence_number: int32
        (sequenceNumber >>> 16) & 0xFF,
        (sequenceNumber >>>  8) & 0xFF,
        (sequenceNumber) & 0xFF
    ]);

    return box(_types.mfhd, data);
}

function traf(track) {
    //console.log(track)
    var trackFragmentHeader = null, trackFragmentDecodeTime = null, trackFragmentRun = null, dataOffset = null;
    trackFragmentHeader = box(_types.tfhd, new Uint8Array([0, 2, 0, 0, 0, 0, 0, 1]));
    trackFragmentDecodeTime = box(_types.tfdt,
        new Uint8Array([
            0, 0, 0, 0,
            track.baseMediaDecodeTime >>> 24 & 255,
            track.baseMediaDecodeTime >>> 16 & 255,
            track.baseMediaDecodeTime >>> 8 & 255,
            track.baseMediaDecodeTime & 255
        ]));
    dataOffset = 16 + 16 + 8 + 16 + 8 + 8;
    trackFragmentRun = trun(track, dataOffset);
    return box(_types.traf, trackFragmentHeader, trackFragmentDecodeTime, trackFragmentRun)
}

//组装traf
function trun(track, offset) {
    if (track.type === "audio") {
        return audioTrun(track, offset)
    }
    return videoTrun(track, offset)
}

//组装trun
function videoTrun(track, _offset) {
    var bytes = null, samples = null, sample = null, i = 0;
    var offset = _offset;
    samples = track.samples || [];
    if (samples[0].frameDuration === null) {
        offset += 8 + 12 + 4 + 4 * samples.length;
        bytes = trunHeader(samples, offset);
        for (i = 0; i < samples.length; i++) {
            sample = samples[i];
            bytes = bytes.concat([(sample.size & 4278190080) >>> 24, (sample.size & 16711680) >>> 16, (sample.size & 65280) >>> 8, sample.size & 255])
        }
    } else {
        offset += 8 + 12 + 4 + 4 * samples.length + 4 * samples.length;
        bytes = trunHeader1(samples, offset);
        for (i = 0; i < samples.length; i++) {
            sample = samples[i];
            bytes = bytes.concat([(sample.frameDuration & 4278190080) >>> 24, (sample.frameDuration & 16711680) >>> 16, (sample.frameDuration & 65280) >>> 8, sample.frameDuration & 255, (sample.size & 4278190080) >>> 24, (sample.size & 16711680) >>> 16, (sample.size & 65280) >>> 8, sample.size & 255])
        }
    }
    return box(_types.trun, new Uint8Array(bytes))
}

function audioTrun(track, _offset) {
    var bytes = null, samples = null, sample = null, i = 0;
    var offset = _offset;
    samples = track.samples || [];
    offset += 8 + 12 + 8 * samples.length;
    bytes = trunHeader(samples, offset);
    for (i = 0; i < samples.length; i++) {
        sample = samples[i];
        bytes = bytes.concat([(sample.duration & 4278190080) >>> 24, (sample.duration & 16711680) >>> 16, (sample.duration & 65280) >>> 8, sample.duration & 255, (sample.size & 4278190080) >>> 24, (sample.size & 16711680) >>> 16, (sample.size & 65280) >>> 8, sample.size & 255])
    }
    return box(_types.trun, new Uint8Array(bytes))
}

//组装videoTurn
function trunHeader(samples, offset) {
    return [0, 0, 2, 5, (samples.length & 4278190080) >>> 24, (samples.length & 16711680) >>> 16, (samples.length & 65280) >>> 8, samples.length & 255, (offset & 4278190080) >>> 24, (offset & 16711680) >>> 16, (offset & 65280) >>> 8, offset & 255, 0, 0, 0, 0]
}

function trunHeader1(samples, offset) {
    return [0, 0, 3, 5, (samples.length & 4278190080) >>> 24, (samples.length & 16711680) >>> 16, (samples.length & 65280) >>> 8, samples.length & 255, (offset & 4278190080) >>> 24, (offset & 16711680) >>> 16, (offset & 65280) >>> 8, offset & 255, 0, 0, 0, 0]
}

/**
 *
 * @param type
 * @returns {Uint8Array}
 */
function box(type, ...items) {
    let size = 8;
    //Todo: 测试一下这里
    //let arrs = Array.prototype.slice.call(arguments, 1);
    let arrs = [];
    arrs.push(...items);
    for (let i = 0; i < arrs.length; i++) {
        size += arrs[i].byteLength;
    }

    let data = new Uint8Array(size);
    let pos = 0;

    // set size
    data[pos++] = size >>> 24 & 0xFF;
    data[pos++] = size >>> 16 & 0xFF;
    data[pos++] = size >>> 8 & 0xFF;
    data[pos++] = size & 0xFF;

    // set type
    data.set(type, pos);
    pos += 4;

    // set data
    for (let i = 0; i < arrs.length; i++) {
        data.set(arrs[i], pos);
        pos += arrs[i].byteLength;
    }

    return data;
}

// let mp4Remux = new MP4Remux();
// mp4Remux.init();

//ivsDrawer.js
class IvsDrawer {
    constructor(canvas) {
        this.canvas = canvas;
        this.context = canvas.getContext('2d');
    }

    cover(video) {
        console.log('cover')
        let offsetLeft = 0, //canvas和video同级时
            offsetTop = 0,
            //offsetLeft = getOffsetRect(video).left, //canvas为body的子元素时，根据DOM文档定位
            //offsetTop = getOffsetRect(video).top,
            videoHeight = video.videoHeight,
            videoWidth = video.videoWidth,
            width = video.getBoundingClientRect().width || videoWidth,
            height = video.getBoundingClientRect().height || videoHeight;
        this.canvas.style.position = 'absolute';

        //this.canvas.style.top = offsetTop +'px';

        //this.canvas.style.height = height +'px';

        let tempHeight = width * videoHeight / videoWidth;
        if (tempHeight > height) { // 如果缩放后的高度大于标签宽度，则按照height缩放width
            this.canvas.height = height;
            this.canvas.style.top = offsetTop + 'px';
            //w/height = videoWidth / videoHeight;
            this.canvas.width = videoWidth / videoHeight * height;
            this.canvas.style.left = offsetLeft + (width - videoWidth / videoHeight * height) / 2 + 'px';
        } else {
            this.canvas.width = width;
            this.canvas.style.left = offsetLeft + 'px';
            //width/h = videoWidth / videoHeight;
            this.canvas.height = width * videoHeight / videoWidth;
            this.canvas.style.top = offsetTop + (height - width * videoHeight / videoWidth) / 2 + 'px';
        }
    }


    draw(data, time) {
        this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.context.beginPath();
        data.map((content, k) => {
            //console.log(content.id)
            switch (content.type) {
                case 'rect':
                    this.context.strokeStyle = '#00ff00';
                    if(!content.quality) {
                        this.context.strokeStyle = '#ff0000';
                    }
                    this.context.lineWidth = 1;//线条的宽度

                    let rect = this._toRealCoordinate(content.rect[0], content.rect[1]);
                    rect.push.apply(rect, this._toRealCoordinate(content.rect[2], content.rect[3]));
                    this._drawRect(rect);

                    this.context.font = 'bold 20px Arial';
                    this.context.textAlign = 'left';
                    this.context.textBaseline = 'bottom';
                    this.context.fillStyle = '#00ff00';
                    // this._drawText(content.id, rect[0], rect[1]);
                    // if (content.text) {
                    //     this._drawText(content.text, rect[0], rect[1] - 20);
                    // }
                    if(content.text !== undefined) {
                        this._drawText(content.text, rect[0], rect[1]);
                    }
                    this.context.stroke();
                    //console.log('绘制 ', time)
                    break;
                case 'text':
                    break;
                default:
                    console.log('unknown ivs type: ', content.type)
                    break;
            }
        });
    }

    clearCanvas() {
        this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    terminate() {
        this.clearCanvas();
        this.canvas.width = 0;
        this.canvas.height = 0;
    }

    _drawRect(rect) {
        //console.log(rect)
        this.context.rect(rect[0], rect[1], rect[2], rect[3]);
    }

    _drawText(text, x, y) {
        this.context.fillText(text, x, y);
    }

    /**
     * 8191坐标系转真实坐标
     * @param x 8191坐标系 x坐标
     * @param y 8191坐标系 y坐标
     * @returns {number[]} 数组
     * @private
     */
    _toRealCoordinate(x, y) {
        return [parseInt(x * this.canvas.width / 8191), parseInt(y * this.canvas.height / 8191)];
    }
}

/**
 * 获取元素相对于dom文档的坐标
 * @param elem
 * @returns {{top: number, left: number}}
 */
function getOffsetRect(elem) {
    let box = elem.getBoundingClientRect();
    let body = document.body;
    let docElem = document.documentElement;
    let scrollTop = window.pageYOffset || docElem.scrollTop || body.scrollTop;
    let scrollLeft = window.pageXOffset || docElem.scrollLeft || body.scrollLeft;
    let clientTop = docElem.clientTop || body.clientTop || 0;
    let clientLeft = docElem.clientLeft || body.clientLeft || 0;
    let top = box.top + scrollTop - clientTop;
    let left = box.left + scrollLeft - clientLeft;
    return {top: Math.round(top), left: Math.round(left)}
}
