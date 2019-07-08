
const WebSocket = require('ws');
class FireSock {
    constructor() {
        this._incomingMessages = this._incomingMessages.bind(this)
        this._handleDisconnect = this._handleDisconnect.bind(this)
        this.events = {};
        this.options = {}
        this.connected = false
    }
    onEvent(eventName, cb) {
        if (this.events[eventName]) {
            this.events[eventName].cbs.push(cb)
        } else {
            this.events[eventName] = {
                cbs: [cb]
            }
        }
    }
    connect(options) {
        return new Promise((res, rej) => {
            try {

                this.options = { ...options };
                let ws = new WebSocket(this.options.host);

                ws.on('open', () => {
                    ws.on('message', this._incomingMessages);
                    ws.on('close', this._handleDisconnect)
                    this.ws = ws;
                    this.connected = true;
                    this._heartBeatManagement();
                    //  this._eventHandler({ eventName: "connected" })
                    res();
                });
                ws.on('error', (e) => {
                    console.log('WS err', e)
                    this.connected = false;
                    this._handleDisconnect();
                });
                
            } catch (e) {
                this.connected = false;
                this._handleDisconnect();
            }
        })
    }

    _heartBeatManagement(){
        if (this._hearBeat) clearInterval(this._hearBeat);
        this._hearBeat = setInterval(()=>{
          //  this.ws.send("hb");
        }, 1000)
    }
    _incomingMessages(data) {
        try {
            if (data && JSON.parse(data)) {
                data = JSON.parse(data);
            }
          //  console.log(data)
            this._eventHandler(data)
        } catch (e) {

        }

    }
    _eventHandler(ev) {
        Object.keys(this.events).forEach((event) => {
            if (ev.eventName == event) {
                this.events[event].cbs.forEach((cb) => {
                    cb(ev)
                })
            }
        });
    }
    _handleDisconnect(e) {
        if (this.options.reconnect) {
            setTimeout(() => {
                this.connect(this.options).then(() => { })
            }, 1000)
        }
        console.log("lost connection from server", e);
    }

    emit(eventName, eventBody) {
        let event = {
            eventName,
            eventBody
        }
        event = JSON.stringify(event);
        retry = retry.bind(this)
        retry();
        function retry() {
            if (this.ws.readyState === 1) {
                this.ws.send(event)

            } else {
                setTimeout(() => {
                    retry();
                }, 3000)
            }
        }
    }
}
export default FireSock;
