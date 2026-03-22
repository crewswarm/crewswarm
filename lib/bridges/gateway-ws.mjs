export function initGatewayWs(deps) {
    const {
        WebSocket,
        crypto,
        CREWSWARM_RT_URL,
        CREWSWARM_RT_TLS_INSECURE,
        CREWSWARM_RT_TOKEN,
        GATEWAY_URL,
        PROTOCOL_VERSION,
        REQUEST_TIMEOUT_MS,
        CHAT_TIMEOUT_MS,
        CREWSWARM_RT_AGENT,
        CREWSWARM_RT_CHANNELS,
        CREWSWARM_RT_RECONNECT_MS,
        telemetry,
        progress,
        parseJsonSafe,
        parseTextContent,
        withRetry,
        sleep,
        b64url,
        deriveRaw,
        syncOpenCodePermissions,
        handleRealtimeEnvelope,
        setRtClient,
        setRtClientForRunners,
    } = deps;

    function createRealtimeClient({ onEnvelope, agentName = CREWSWARM_RT_AGENT, token = CREWSWARM_RT_TOKEN, channels = CREWSWARM_RT_CHANNELS }) {
        return new Promise((resolveConnect, rejectConnect) => {
            const ws = new WebSocket(CREWSWARM_RT_URL, CREWSWARM_RT_URL.startsWith("wss://") && CREWSWARM_RT_TLS_INSECURE
                ? { rejectUnauthorized: false }
                : undefined);
            let ready = false;
            let settled = false;

            function sendFrame(frame) {
                if (ws.readyState !== WebSocket.OPEN) {
                    throw new Error("realtime socket is not open");
                }
                ws.send(JSON.stringify(frame));
            }

            const client = {
                publish({ channel, type, to = "broadcast", taskId, correlationId, priority = "medium", payload = {} }) {
                    sendFrame({
                        type: "publish",
                        channel,
                        messageType: type,
                        to,
                        taskId,
                        correlationId,
                        priority,
                        payload,
                    });
                },
                ack({ messageId, status = "received", note = "" }) {
                    sendFrame({ type: "ack", messageId, status, note });
                },
                close() {
                    ws.close();
                },
                isReady() {
                    return ready;
                },
            };

            ws.on("open", () => {
                telemetry("realtime_open", { url: CREWSWARM_RT_URL, agent: agentName });
            });

            ws.on("message", async (d) => {
                const p = parseJsonSafe(d.toString(), null);
                if (!p) return;

                if (p.type === "server.hello") {
                    sendFrame({ type: "hello", agent: agentName, token });
                    return;
                }

                if (p.type === "hello.ack") {
                    sendFrame({ type: "subscribe", channels });
                    ready = true;
                    if (!settled) {
                        settled = true;
                        resolveConnect(client);
                    }
                    telemetry("realtime_ready", { channels, agent: agentName });
                    return;
                }

                if (p.type === "error") {
                    const err = new Error(`realtime error: ${p.message || "unknown"}`);
                    telemetry("realtime_error", { message: err.message });
                    if (!settled) {
                        settled = true;
                        rejectConnect(err);
                    }
                    return;
                }

                if (p.type === "message" && p.envelope && typeof onEnvelope === "function") {
                    try {
                        await onEnvelope(p.envelope, client);
                    } catch (err) {
                        telemetry("realtime_handler_error", { message: err?.message ?? String(err) });
                    }
                }
            });

            ws.on("close", () => {
                ready = false;
                telemetry("realtime_closed", { url: CREWSWARM_RT_URL });
                if (!settled) {
                    settled = true;
                    rejectConnect(new Error("realtime connection closed before ready"));
                }
            });

            ws.on("error", (e) => {
                ready = false;
                telemetry("realtime_socket_error", { message: e?.message ?? String(e) });
                if (!settled) {
                    settled = true;
                    rejectConnect(e);
                }
            });
        });
    }

    function createBridge({ dev, authToken }) {
        return new Promise((resolveConnect, rejectConnect) => {
            const ws = new WebSocket(GATEWAY_URL);
            const pending = new Map();
            let settled = false;
            let reply = "";
            let replyDone = false;
            let onDone = null;

            function send(method, params) {
                return new Promise((res, rej) => {
                    if (ws.readyState !== WebSocket.OPEN) {
                        rej(new Error(`websocket is not open for ${method}`));
                        return;
                    }
                    const id = crypto.randomUUID();
                    const timeout = setTimeout(() => {
                        pending.delete(id);
                        rej(new Error(`timeout: ${method}`));
                    }, REQUEST_TIMEOUT_MS);
                    pending.set(id, {
                        resolve: (v) => { clearTimeout(timeout); res(v); },
                        reject: (e) => { clearTimeout(timeout); rej(e); },
                    });
                    ws.send(JSON.stringify({ type: "req", id, method, params }));
                });
            }

            function doConnect(nonce) {
                const role = "operator", scopes = ["operator.admin"], signedAtMs = Date.now();
                const ver = nonce ? "v2" : "v1";
                const payloadStr = [ver, dev.deviceId, "gateway-client", "ui", role, scopes.join(","), String(signedAtMs), authToken || "", ...(nonce ? [nonce] : [])].join("|");
                const sig = b64url(crypto.sign(null, Buffer.from(payloadStr, "utf8"), crypto.createPrivateKey(dev.privateKeyPem)));

                send("connect", {
                    minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION,
                    client: { id: "gateway-client", displayName: "crewHQ", version: "1.0.0", platform: process.platform, mode: "ui", instanceId: crypto.randomUUID() },
                    caps: ["tool-events"], role, scopes,
                    device: { id: dev.deviceId, publicKey: b64url(deriveRaw(dev.publicKeyPem)), signature: sig, signedAt: signedAtMs, ...(nonce ? { nonce } : {}) },
                    ...(authToken ? { auth: { token: authToken } } : {}),
                }).then(() => {
                    settled = true;
                    resolveConnect({
                        send, ws,
                        chat: (msg, sessionKey = CREWSWARM_RT_AGENT || "main", options = {}) => {
                            reply = ""; replyDone = false;
                            return new Promise((res, rej) => {
                                onDone = (text) => res(text);
                                const idempotencyKey = String(options?.idempotencyKey || crypto.randomUUID());
                                ws.send(JSON.stringify({
                                    type: "req", id: crypto.randomUUID(), method: "chat.send",
                                    params: { sessionKey, message: msg, thinking: "low", idempotencyKey },
                                }));
                                setTimeout(() => {
                                    if (!replyDone) { replyDone = true; res(reply || "(timeout - no reply)"); }
                                }, CHAT_TIMEOUT_MS);
                            });
                        },
                        close: () => ws.close(),
                    });
                }).catch(rejectConnect);
            }

            ws.on("message", (d) => {
                const p = JSON.parse(d.toString());
                if (p.event === "connect.challenge") { doConnect(p.payload?.nonce); return; }
                if (p.event === "tick" || p.event === "health") return;

                // Streaming: agent events carry cumulative text
                if (p.event === "agent" && p.payload?.stream === "text") {
                    const data = p.payload?.data;
                    if (typeof data === "string") reply = data;
                    else if (data?.text) reply = data.text;
                    return;
                }

                // Chat done event carries final message
                if (p.event === "chat") {
                    const msg = p.payload?.message;
                    if (msg) {
                        const text = parseTextContent(msg.content);
                        if (text) reply = text;
                    }
                    const state = p.payload?.state;
                    if (state === "idle" || state === "done" || state === "error") {
                        replyDone = true;
                        onDone?.(reply);
                    }
                    return;
                }

                // Response frames
                if (p.id && pending.has(p.id)) {
                    const h = pending.get(p.id);
                    pending.delete(p.id);
                    if (p.ok) h.resolve(p.payload); else h.reject(new Error(p.error?.message ?? "unknown"));
                }
            });

            ws.on("error", (e) => {
                if (!settled) rejectConnect(e);
            });
            ws.on("close", () => {
                for (const h of pending.values()) h.reject(new Error("connection closed"));
                pending.clear();
                if (!settled) rejectConnect(new Error("connection closed before connect response"));
            });
            ws.on("open", () => setTimeout(() => doConnect(null), 1200));
        });
    }

    async function runRealtimeDaemon(bridge) {
        syncOpenCodePermissions();
        progress(`Starting OpenCrew realtime daemon via ${CREWSWARM_RT_URL}...`);
        let stopRequested = false;
        let currentClient = null;
        let heartbeat = null;

        const shutdown = () => {
            stopRequested = true;
            if (heartbeat) {
                clearInterval(heartbeat);
                heartbeat = null;
            }
            try {
                currentClient?.publish({ channel: "events", type: "agent.offline", payload: { agent: CREWSWARM_RT_AGENT } });
            } catch (e) {
                console.error(`[gateway-bridge] Failed to publish offline event: ${e.message}`);
            }
            try {
                currentClient?.close();
            } catch (e) {
                console.error(`[gateway-bridge] Failed to close RT client: ${e.message}`);
            }
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);

        while (!stopRequested) {
            try {
                const rt = await withRetry(() => createRealtimeClient({
                    onEnvelope: async (envelope, client) => handleRealtimeEnvelope(envelope, client, bridge),
                }), { retries: 2, baseDelayMs: 300, label: "realtime connect" });

                currentClient = rt;
                setRtClient(rt); // wire into tool executor for cmd approval requests
                setRtClientForRunners(rt); // wire into engine runners for agent_working/agent_idle
                rt.publish({
                    channel: "events",
                    type: "agent.online",
                    to: "broadcast",
                    priority: "high",
                    payload: {
                        agent: CREWSWARM_RT_AGENT,
                        gateway: GATEWAY_URL,
                        mode: "daemon",
                    },
                });

                console.log(`OpenCrew daemon online: ${CREWSWARM_RT_AGENT}`);
                console.log(`- gateway: ${GATEWAY_URL}`);
                console.log(`- realtime: ${CREWSWARM_RT_URL}`);
                console.log(`- subscribed: ${CREWSWARM_RT_CHANNELS.join(", ")}`);

                heartbeat = setInterval(() => {
                    try {
                        rt.publish({
                            channel: "status",
                            type: "agent.heartbeat",
                            to: "broadcast",
                            payload: { agent: CREWSWARM_RT_AGENT, ts: new Date().toISOString() },
                        });
                    } catch (e) {
                        console.error(`[gateway-bridge] Failed to publish heartbeat: ${e.message}`);
                    }
                }, 30000);

                await new Promise((resolve) => {
                    const poll = setInterval(() => {
                        if (stopRequested || !rt.isReady()) {
                            clearInterval(poll);
                            resolve();
                        }
                    }, 1000);
                });

                if (heartbeat) {
                    clearInterval(heartbeat);
                    heartbeat = null;
                }
                try {
                    rt.close();
                } catch (e) {
                    console.error(`[gateway-bridge] Failed to close RT connection: ${e.message}`);
                }
                currentClient = null;
                if (!stopRequested) {
                    progress(`Realtime disconnected. Reconnecting in ${CREWSWARM_RT_RECONNECT_MS}ms...`);
                    await sleep(CREWSWARM_RT_RECONNECT_MS);
                }
            } catch (err) {
                telemetry("realtime_daemon_error", { message: err?.message ?? String(err) });
                progress(`Realtime daemon error: ${err?.message ?? String(err)}`);
                if (!stopRequested) await sleep(CREWSWARM_RT_RECONNECT_MS);
            }
        }
    }

    return {
        createRealtimeClient,
        createBridge,
        runRealtimeDaemon
    };
}
