const WebSocket = require('ws');
const crypto = require("crypto");
const redis = require("redis");
class Utils {
    constructor() {
        this.joinSession = this.joinSession.bind(this)
        this.leaveSession = this.leaveSession.bind(this)
        this.broadcastToSession = this.broadcastToSession.bind(this);

    }
    sendParsed(ws, obj) {
        ws.send(JSON.stringify(obj));

    }
    emitToSocket(ws, eventName, obj) {
        let eventObj = {
            eventName: eventName,
            eventBody: obj
        }
        ws.send(JSON.stringify(eventObj))
    }
    setUserInfo(ws, ob) {

        Object.keys(ob).forEach((key) => {
            ws.userInfo[key] = ob[key]

        })

    }
    log() {
        if (this.opts.logging) {

            console.log(arguments)
        }
    }
}
class BlueSocket extends Utils {

    constructor(opts) {
        super()
        let defaults = {
            logging: true
        }
        this.nodeId = crypto.randomBytes(7).toString("hex");
        this._eventLists = {};
        this.state = {
            nodeCluster: {},
            fetchingNodes: false,
            fetchedNodes: {},
            currentClients: {}
        }
        this.opts = { ...opts, defaults };

        this._startListener(this.opts.port);
        this._setupRedis();
    }

    onEvents(eventName, cb) {
        if (this._eventLists[eventName]) {
            this._eventLists[eventName].cbs.push(cb)
        } else {
            this._eventLists[eventName] = {
                cbs: [
                    cb
                ]
            }
        }
    }

    _setupRedis() {
        const redisServer = {
            ...this.opts.redis
        }
        let sub = redis.createClient(redisServer)
        let redisClient = redis.createClient(redisServer)
        let pub = redis.createClient(redisServer);
        this.pub = pub;
        this.sub = sub;
        redisClient.on("error", function (err) {
            this.log("Error " + err);
        });

        this.subscribeToRedis();
    }

    _startListener(port) {
        this.log(port)
        let wss = new WebSocket.Server({
            port: port,
            perMessageDeflate: {
                zlibDeflateOptions: {
                    // See zlib defaults.
                    chunkSize: 1024,
                    memLevel: 7,
                    level: 3
                },
                zlibInflateOptions: {
                    chunkSize: 10 * 1024
                },
                // Other options settable:
                clientNoContextTakeover: true, // Defaults to negotiated value.
                serverNoContextTakeover: true, // Defaults to negotiated value.
                serverMaxWindowBits: 10, // Defaults to negotiated value.
                // Below options specified as default values.
                concurrencyLimit: 10, // Limits zlib concurrency for perf.
                threshold: 1024 // Size (in bytes) below which messages
                // should not be compressed.
            }
        });

        wss.on('connection', async (ws) => {
            let userId = crypto.randomBytes(16).toString("hex");
            if (!this.state.currentClients[userId]) {

                ws.id = userId
            } else {
                ws.id = crypto.randomBytes(16).toString("hex");
            }
            this._handleIncomingSocketCommunication(ws)
            this.state.currentClients[userId] = {
                joined: new Date().toISOString(),
                id: userId,

            }
            ws.userInfo = { userId }
            this.sendParsed(ws, {

                eventName: "connected",
                eventBody: { userId: userId }
            })
            if (this._eventLists["connected"]) {
                this._eventLists["connected"].cbs.forEach((cb) => {
                    cb({ eventName: "connected", eventBody: { userId } }, ws)
                })
            }
            await this.publishToRedis("connected", { userId }, true)

        });
        this.wss = wss;
        this.log("starting wss service")

    }

    _handleIncomingSocketCommunication(ws) {
        ws.on('message', (message) => {
            this.log(ws.id)
            this.log('from client:', message);
            if (message === "hb") {
                ws.userInfo.hb = new Date().getTime()
                // this._updateSessionInfoRedis(ws.userInfo.sessionId).users({...ws.userInfo})
            }
            try {
                if (message && JSON.parse(message) && JSON.parse(message).eventName) {
                    let event = JSON.parse(message)
                    //  this.publishToRedis(event.eventName, event.eventBody, false, ws)
                    Object.keys(this._eventLists).forEach((key) => {
                        if (event.eventName === key) {

                            this._eventLists[key].cbs.forEach((cb) => {
                                cb(event, ws)
                            })

                        }
                    })

                }

            } catch (e) {

            }
        });
        ws.on('close', () => {
            this._handleDisconnect(ws);
        });
    }

    async _handleDisconnect(ws) {
        this.log(ws.id, "has disconnected")
        if (this.state.currentClients[ws.id]) {
            delete this.state.currentClients[ws.id]
            await this.publishToRedis("disconnected", { userId: ws.id }, true)
            if (this._eventLists["disconnected"]) {
                this._eventLists["disconnected"].cbs.forEach((cb) => {
                    cb({ eventName: "disconnected", eventBody: { userId: ws.id } }, ws)
                })
            }
            // this._updateSessionInfoRedis(ws.userInfo.sessionId).cleanUser(ws.userInfo)
        }
    }

    broadcastToSession(eventName, eventObj, ws) {
        this.publishToRedis(eventName, eventObj, false, ws)
    }

    publishToRedis(event, obj, isInternal = false, ws) {
        let { pub } = this;
        return new Promise((r) => {

            let id = crypto.randomBytes(8).toString("hex");
            let eventObj = {
                eventName: event,
                eventBody: obj
            }
            if (ws) {
                eventObj.userId = ws.id;
                eventObj.sessionId = ws.userInfo.sessionId;
            }
            pub.publish(`firesockets-${isInternal ? 'internal' : 'events'}-${id}`, JSON.stringify(eventObj), () => {
                r();
            })
        })
    }

    async nodeConnected() {
        let { nodeId } = this;
        let { sub, pub } = this;
        if (this.nodeConnectionHeartbeatInterval) {
            clearInterval(this.nodeConnectionHeartbeatInterval)
        }
        if (this.clusterBeats) {
            clearInterval(this.clusterBeats)
        }


        this.nodeConnectionHeartbeatInterval = setInterval(() => {
            pub.publish(`firesockets-nodes-${nodeId}`, JSON.stringify({ nodeId }), () => {

            })
        }, 5000)
        this.clusterBeats = setInterval(() => {
            Object.keys(this.state.nodeCluster).forEach((node) => {
                if (this.state.nodeCluster[node] > new Date().getTime() - 20000) {

                } else {
                    delete this.state.nodeCluster[node];
                }
            })
        }, 20000)

    }


    subscribeToRedis() {
        let { sub } = this;
        sub.on("pmessage", (channel, pattern, message) => {
            if (channel == 'firesockets-nodes-*') {
                this._assignClusterTags(channel, pattern, message)
            } else {

                this.log("pmessage", channel, pattern, message)
                this.handleRedisEventSubscriptions(channel, pattern, message)
            }
        });
        sub.psubscribe('firesockets-events-*', (error, count) => {
            this.log(error, count)
        });
        sub.psubscribe('firesockets-nodes-*', (error, count) => {
            this.log(error, count)
        });
        sub.psubscribe('firesockets-internal-*', async (error, count) => {
            this.log(error, count)
            this.nodeConnected();
            await this.publishToRedis("nodeConnected", { nodeId: this.nodeId }, true)
        });
    }

    _assignClusterTags(channel, pattern, message) {
        let event = JSON.parse(message)
        this.state.nodeCluster[event.nodeId] = new Date().getTime();
    }
    handleRedisEventSubscriptions(channel, pattern, message) {
        this.log("sub channel " + pattern + ": " + message);
        let event = JSON.parse(message)
        this.wss.clients.forEach((client) => {
            let userInfo = client.userInfo;
            event.userInfo = { ...userInfo };
            if (userInfo.sessionId && userInfo.sessionId === event.sessionId) {
                this.sendParsed(client, event)
            }
        })
        switch (event.eventName) {
            case "nodeConnected":
                if (event.eventBody.nodeId !== this.nodeId) {
                    this.log(`node id ${event.eventBody.nodeId} connected to cluster`);
                }

                break;
            case "usersInNode":
                this.log("userRequestFromNodes")

                let users = []
                this.wss.clients.forEach((client) => {
                    this.log(client.userInfo.sessionId)
                    if (client.userInfo.sessionId == event.eventBody.sessionId) {
                        users.push({ ...client.userInfo })
                    }
                })
                this.publishToRedis("usersInMyNode", { nodeId: this.nodeId, users }, true)
                break;
            case "usersInMyNode":
                if (this.state.fetchingNodes) {
                    this.log("usersInMyNode")
                    let { nodeId } = event.eventBody;
                    this.state.fetchedNodes[nodeId] = { ...event.eventBody };
                }
                break;
        }

    }

    fetchStates() {
        return this.state;
    }

    joinSession(event, ws) {
        this.wss.clients.forEach((client) => {
            if (client.id === ws.id) {
                this.state.currentClients[ws.id].sessionId = event.eventBody.sessionId;
                client.userInfo.sessionId = event.eventBody.sessionId;
                // this._updateSessionInfoRedis(client.userInfo.sessionId).users({ ...client.userInfo })

            }
        })
    }
    leaveSession(event, ws) {
        this.wss.clients.forEach((client) => {
            if (client.id === ws.id) {
                this.state.currentClients[ws.id].sessionId = null;
                client.userInfo.sessionId = null;
            }
        })
    }

    async getUsersInSession(sessionId) {
        return new Promise(async (resolve, reject) => {
            this.state.fetchingNodes = true;
            this.state.fetchedNodes = {}
            let compiledFinalList = [];
            let maxNodes = 0;
            await this.publishToRedis("usersInNode", { masterAskNodeId: this.nodeId, sessionId }, true)
            //  resolve(["someone"])
            let limiter = 0;
            longAsync = longAsync.bind(this);

            maxNodes = Object.keys(this.state.nodeCluster).length
            this.log(maxNodes)
            longAsync();

            async function longAsync() {
                let finished = false;
                if (limiter > 5) {
                    this.state.fetchingNodes = false;
                    return;
                }

                this.log("nodes in memory", this.state.fetchedNodes)
                this.log("max nodes count", maxNodes)
                let fetched = Object.keys(this.state.fetchedNodes).length
                if (fetched == maxNodes) {
                    Object.keys(this.state.fetchedNodes).forEach((nod) => {
                        if (this.state.fetchedNodes[nod].users.length > 0) {
                            this.state.fetchedNodes[nod].users.forEach((user) => {
                                compiledFinalList.push({ ...user })
                            })
                        }
                    })
                    resolve(compiledFinalList)
                    return
                } else {

                    setTimeout(() => {
                        limiter++;
                        longAsync();
                    }, 100)
                }
            }
        })

    }

    getSessionMeta(sessionId) {
        let {pub} = this;
        return new Promoise((resolve, reject) => {
            pub.get(`syncSessions-${sessionId}`, (e, data) => {
                try {
                    if (data && JSON.parse(data)) {
                        data = JSON.parse(data);
                    }
                } catch (e) {

                }
                if (data) {
                    let update = { ...data }

                    resolve(update)
                }


            });
        })
    }
    updateSessionMeta(ws, metaData) {
        this._updateSessionInfoRedis(ws.userInfo.sessionId).metaData(
            metaData
        )
    }
    _updateSessionInfoRedis(sessionId) {
        let { pub } = this;
        return {
            metaData: (metaUpdate) => {
                pub.get(`syncSessions-${sessionId}`, (e, data) => {
                    try {
                        if (data && JSON.parse(data)) {
                            data = JSON.parse(data);
                        }
                    } catch (e) {

                    }
                    if (data) {
                        let update = { ...data }
                        Object.keys(metaUpdate).forEach((key) => {
                            update.metaData[key] = metaUpdate[key]

                        })
                        this.log("session update", update)
                        pub.set(`syncSessions-${sessionId}`, JSON.stringify(update), 'EX', 60 * 60 * 24, () => {
                            this.broadcastToSession("sessionInfo", { ...update }, { id: "SERVER", userInfo: { sessionId: sessionId } })

                        })
                    }


                });
            }

        }
    }
}

module.exports = BlueSocket;