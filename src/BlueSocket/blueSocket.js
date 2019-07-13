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
            let out = "";
            Object.keys(arguments).forEach((k) => {
                out = `${out} ${arguments[k]}`
            })
            console.log(out)
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
            opperateAsMaster: false,
            nodeCluster: {},
            fetchedNodes: {},
            fetchedSessions: {},
            currentClients: {},
            userStatesRequests:{queue:[]}
        }
        this.opts = { ...opts, defaults };
        if (this.opts.masterOnly) {
            this.state.opperateAsMaster = true;
        }
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
        if (this.state.opperateAsMaster) return;
        this.log(port)
        let wss = new WebSocket.Server({ server: this.opts.httpServer });

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

    broadcastToSession(eventName, eventObj, ws, directId) {
        this.publishToRedis(eventName, eventObj, false, ws, directId)
    }

    publishToRedis(event, obj, isInternal = false, ws, directId) {
        let { pub } = this;
        return new Promise((r) => {

            let id = crypto.randomBytes(8).toString("hex");
            let eventObj = {
                eventName: event,
                eventBody: obj
            }
            if (ws) {
                eventObj.userId = ws.id;
                eventObj.userInfo = ws.userInfo;
                eventObj.sessionId = ws.userInfo.sessionId;
            }
            if (directId) {
                eventObj.userId = "SERVER";
                eventObj.userInfo = { user: "SERVER" };
                eventObj.sessionId = directId

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


        if (!this.state.opperateAsMaster) {
            this.nodeConnectionHeartbeatInterval = setInterval(() => {
                pub.publish(`firesockets-nodes-${nodeId}`, JSON.stringify({ nodeId, ts: new Date().getTime() }), () => {

                })
            }, 5000)
        }
        if (this.state.opperateAsMaster) {

            this.clusterBeats = setInterval(() => {
                console.log("master: node starting")
                console.log("master: nodes right now: ", Object.keys(this.state.nodeCluster).length)
                Object.keys(this.state.nodeCluster).forEach((node) => {
                    console.log("master: node states ", this.state.nodeCluster[node])
                    if (this.state.nodeCluster[node] > new Date().getTime() - 20000) {

                    } else {
                        delete this.state.nodeCluster[node];
                    }
                })
            }, 10000)
        }

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
        let { opperateAsMaster } = this.state;
        //this.log("sub channel " + pattern + ": " + message);
        let event = JSON.parse(message)
        if (!opperateAsMaster) {

            this.wss.clients.forEach((client) => {
                let userInfo = client.userInfo;
                //  event.userInfo = { ...userInfo };
                if (userInfo.sessionId && userInfo.sessionId === event.sessionId) {
                    this.sendParsed(client, event)
                }
            })
            switch (event.eventName) {
                case "getUsersInSession":
                    console.log("usersInSession incoming", event)

                    let users = []
                    this.wss.clients.forEach((client) => {
                        this.log(client.userInfo.sessionId)
                        if (client.userInfo.sessionId == event.eventBody.sessionId) {
                            if (client.readyState == 1) {

                                users.push({ ...client.userInfo })
                            }
                        }
                    })
                    this.publishToRedis("master-usersInMyNode", { nodeId: this.nodeId, users, sessionId: event.eventBody.sessionId }, true)
                    break;
                case "master-usersInSessionCompiled":
                    console.log("usersInSessionCompiled incoming", event)
                    if (this.state.userStatesRequests.queue.length > 0){
                        this.state.userStatesRequests.queue.forEach((q,i)=>{
                            q(event.eventBody.users);
                            this.state.userStatesRequests.queue.splice(i,1);
                        })
                    }
            }
        }

        if (opperateAsMaster) {
            let { sessionId } = event.eventBody;
            switch (event.eventName) {
                case "nodeConnected":
                    if (event.eventBody.nodeId !== this.nodeId) {
                        this.log(`node id ${event.eventBody.nodeId} connected to cluster`);
                    }

                    break;
                case "getUsersInSession":
                    if (!this.state.fetchedSessions[sessionId]) {
                        this.state.fetchedSessions[sessionId] = {
                            uniqueNodes:{},
                            nodes: [],
                      
                        }
                    }
                    this.compileAllUsersInSession(sessionId)

                    break;
                case "master-usersInMyNode":
                    this.log("usersInMyNode")
                    let { nodeId, users } = event.eventBody;
                    if (this.state.fetchedSessions[sessionId]){

                        if (!this.state.fetchedSessions[sessionId].uniqueNodes[nodeId]){
                            this.state.fetchedSessions[sessionId].uniqueNodes[nodeId]= nodeId;
                            this.state.fetchedSessions[sessionId].nodes.push({ nodeId, users })
                        }
                    }
                    break;
            }
        }
    }

    async compileAllUsersInSession(sessionId) {
        if (!this.state.opperateAsMaster) return;
        if (this.state.fetchedSessions[sessionId].running) return;
        this.state.fetchedSessions[sessionId].running = true;
        this.log("------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------")
        let limiter = 0;
        let compiledFinalList = [];
        let maxNodes = 0;
        longAsync = longAsync.bind(this);

        maxNodes = Object.keys(this.state.nodeCluster).length
        this.log(maxNodes)
        longAsync();

        async function longAsync() {
            if (limiter > 100) {
                delete this.state.fetchedSessions[sessionId]
                this.log("failed to fetch all nodes on session users request....")
                compiledFinalList = null;
                return;
            }

            this.log("nodes in memory", this.state.fetchedSessions[sessionId])
            this.log("max nodes count", maxNodes)
            let fetched = this.state.fetchedSessions[sessionId].nodes.length;
            this.log("fetched nodes", fetched)
            if (fetched == maxNodes) {


                this.state.fetchedSessions[sessionId].nodes.forEach((item) => {
                    if (item.users.length>0){
                        item.users.forEach((user)=>{
                            compiledFinalList.push({...user})

                        })

                    }
                })

                
                this.log("send out finallist", compiledFinalList)
                this.publishToRedis("master-usersInSessionCompiled", { nodeId: this.nodeId, users: compiledFinalList }, true)
                delete this.state.fetchedSessions[sessionId]
                compiledFinalList = null;
                return
            } else {

                setTimeout(() => {
                    limiter++;
                    longAsync();
                }, 100)
            }
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
            await this.publishToRedis("getUsersInSession", { sessionId }, true)
            this.state.userStatesRequests.queue.push(resolve)


            return
            if (this.state.userStatesRequests[sessionId] && this.state.userStatesRequests[sessionId].waiting){
                return
            }
            this.state.userStatesRequests[sessionId]= {
                users:[],
                waiting:true,
            }
            //  resolve(["someone"])
            resolver = resolver.bind(this)
            resolver();
            function resolver(){
                if (this.state.userStatesRequests[sessionId].waiting){

                }
            }
        })

    }
    getNodesCurrentUniqueSessions(){
        return new Promise(async (resolve, reject) => {
            let sessions = [];
            this.wss.clients.forEach((client) => {
              
                sessions.push(client.userInfo.sessionId);
        
            })
            resolve(sessions)
        }) 
    }
    getSessionMeta(sessionId) {
        let { pub } = this;

        return new Promise((resolve, reject) => {
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
                    if (!data) {
                        data = {
                            metaData: {}
                        }
                    }
                    let update = { ...data }
                    Object.keys(metaUpdate).forEach((key) => {
                        update.metaData[key] = metaUpdate[key]

                    })
                    this.log("session update", update)
                    pub.set(`syncSessions-${sessionId}`, JSON.stringify(update), 'EX', 60 * 60 * 24, () => {
                        //  this.broadcastToSession("sessionInfo", { ...update }, { id: "SERVER", userInfo: { sessionId: sessionId } })

                    })


                });
            }

        }
    }
}

module.exports = BlueSocket;