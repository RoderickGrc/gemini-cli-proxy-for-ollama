const express = require("express");
const cors = require("cors");
const { OAuth2Client } = require("google-auth-library");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const readline = require("readline");

/**
 * Google Code Assist API endpoint and configuration.
 */
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_API_VERSION = "v1internal";
const OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = "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";
const OAUTH_REDIRECT_URI = "http://localhost:45289";

const geminiCliModels = {
    "gemini-2.5-pro": { maxTokens: 65536 },
    "gemini-2.5-flash": { maxTokens: 65536 }
};

/**
 * Handles authentication and requests to the Gemini Code Assist API.
 */
class GeminiCliHandler {
    constructor(options = {}) {
        this.options = options;
        this.authClient = new OAuth2Client(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URI);
        this.projectId = null;
        this.authInitialized = false;
    }

    /**
     * Loads OAuth2 credentials from the standard Gemini CLI file location.
     * Throws if credentials are missing.
     */
    async loadOAuthCredentials() {
        const credPath = process.env.GEMINI_CLI_OAUTH_PATH || path.join(os.homedir(), ".gemini", "oauth_creds.json");
        try {
            return JSON.parse(await fs.readFile(credPath, "utf8"));
        } catch (err) {
            throw new Error(`Failed to load credentials from ${credPath}. Please authenticate with 'gemini auth' first.`);
        }
    }

    /**
     * Initializes OAuth authentication, refreshing tokens as needed.
     */
    async initializeAuth(forceRefresh = false) {
        if (this.authInitialized && !forceRefresh && this.authClient.credentials.expiry_date > Date.now()) {
            return;
        }
        const credentials = await this.loadOAuthCredentials();
        this.authClient.setCredentials(credentials);

        if (credentials.expiry_date && Date.now() > credentials.expiry_date && credentials.refresh_token) {
            try {
                const { credentials: newCredentials } = await this.authClient.refreshAccessToken();
                this.authClient.setCredentials(newCredentials);
            } catch (error) {
                throw new Error("Failed to refresh OAuth token.");
            }
        }
        this.authInitialized = true;
    }

    /**
     * Discovers or creates a projectId for Code Assist interaction.
     * This ensures the handler can be used with different Google accounts.
     */
    async discoverProjectId() {
        if (this.projectId) {
            return this.projectId;
        }
        if (process.env.GOOGLE_CLOUD_PROJECT) {
            this.projectId = process.env.GOOGLE_CLOUD_PROJECT;
            return this.projectId;
        }
        await this.initializeAuth();

        const initialProjectId = "default";
        const clientMetadata = {
            ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI", duetProject: initialProjectId,
        };

        try {
            const loadRequest = { cloudaicompanionProject: initialProjectId, metadata: clientMetadata };
            const loadResponse = await this.authClient.request({
                url: `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:loadCodeAssist`,
                method: "POST", body: JSON.stringify(loadRequest),
            });

            if (loadResponse.data.cloudaicompanionProject) {
                this.projectId = loadResponse.data.cloudaicompanionProject;
                return this.projectId;
            }

            const defaultTier = loadResponse.data.allowedTiers?.find(tier => tier.isDefault);
            const tierId = defaultTier?.id || "free-tier";
            const onboardRequest = { tierId, cloudaicompanionProject: initialProjectId, metadata: clientMetadata };

            let lroResponse = await this.authClient.request({
                url: `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:onboardUser`,
                method: "POST", body: JSON.stringify(onboardRequest),
            });

            while (!lroResponse.data.done) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                lroResponse = await this.authClient.request({
                    url: `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:onboardUser`,
                    method: "POST", body: JSON.stringify(onboardRequest),
                });
            }

            const discoveredProjectId = lroResponse.data.response?.cloudaicompanionProject?.id || initialProjectId;
            this.projectId = discoveredProjectId;
            return this.projectId;
        } catch (error) {
            throw new Error("Project ID discovery failed. Ensure you are authenticated and using a personal Google account.");
        }
    }

    /**
     * Parses an SSE stream from the API, yielding JSON-decoded messages.
     */
    async *parseSSEStream(stream) {
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
            if (line.startsWith("data: ")) {
                const data = line.slice(6).trim();
                if (data) {
                    try {
                        yield JSON.parse(data);
                    } catch (e) {
                        // Malformed chunk, skip.
                    }
                }
            }
        }
    }

    /**
     * Sends a prompt/messages to Gemini and returns a stream iterator.
     */
    async createMessage(messages, modelId) {
        const projectId = await this.discoverProjectId();
        const modelInfo = geminiCliModels[modelId] || geminiCliModels["gemini-2.5-flash"];

        const contents = messages.map(msg => ({
            role: msg.role === "assistant" ? "model" : msg.role,
            parts: [{ text: msg.content || "" }].concat(
                (msg.images || []).map(base64Img => ({
                    inline_data: { mime_type: "image/jpeg", data: base64Img }
                }))
            ),
        }));

        const streamRequest = {
            model: modelId, project: projectId, request: {
                contents, generationConfig: {
                    temperature: 0.7, maxOutputTokens: modelInfo.maxTokens || 8192,
                },
            },
        };

        try {
            const response = await this.authClient.request({
                url: `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:streamGenerateContent`,
                method: "POST", params: { alt: "sse" }, headers: { "Content-Type": "application/json" },
                responseType: "stream", body: JSON.stringify(streamRequest),
            });
            return this.parseSSEStream(response.data);
        } catch (error) {
            throw new Error("Error communicating with the Gemini API.");
        }
    }
}

/**
 * Express server configuration for Gemini CLI proxy compatible with Ollama and OpenAI clients.
 */
const app = express();
const OLLAMA_PORT = 11434;

app.use(cors());
app.use(express.json({ limit: "80mb" }));

const handler = new GeminiCliHandler();

/**
 * Handles Ollama /api/chat and compatible chat-completions style endpoints.
 * Supports both streaming and non-streaming requests.
 */
const processOllamaChat = async (req, res) => {
    const { model, messages, stream = true } = req.body;
    const modelId = model.replace(":latest", "");

    if (!model || !messages) {
        return res.status(400).json({ error: "Fields 'model' and 'messages' are required." });
    }

    try {
        const createdAt = new Date().toISOString();
        const geminiStream = await handler.createMessage(messages, modelId);

        if (!stream) {
            let fullResponse = "";
            for await (const jsonData of geminiStream) {
                const text = jsonData.response?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) fullResponse += text;
            }
            const ollamaResponse = { model, created_at: createdAt, message: { role: "assistant", content: fullResponse }, done: true };
            return res.json(ollamaResponse);
        }

        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("Transfer-Encoding", "chunked");
        res.setHeader("X-Accel-Buffering", "no");
        res.setHeader("Cache-Control", "no-cache");
        res.flushHeaders();

        for await (const jsonData of geminiStream) {
            const text = jsonData.response?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text && !res.writableEnded) {
                const ollamaChunk = { model, created_at: createdAt, message: { role: "assistant", content: text }, done: false };
                res.write(JSON.stringify(ollamaChunk) + "\n");
            }
        }

        if (!res.writableEnded) {
            const finalChunk = { model, created_at: createdAt, message: { role: "assistant", content: "" }, done: true };
            res.write(JSON.stringify(finalChunk) + "\n");
        }

        res.end();
    } catch (error) {
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        } else if (!res.writableEnded) {
            res.end();
        }
    }
};

/**
 * Ollama-native endpoints.
 */
app.post("/api/chat", processOllamaChat);

app.post("/api/generate", (req, res) => {
    const { model, prompt, images = [] } = req.body;
    if (!prompt) return res.status(400).json({ error: "Field 'prompt' is required." });
    req.body.messages = [{ role: "user", content: prompt, images }];
    processOllamaChat(req, res);
});

app.get("/api/tags", (req, res) => {
    const models = Object.keys(geminiCliModels).map(name => ({ name: `${name}:latest`, model: `${name}:latest` }));
    res.json({ models });
});

app.get("/api/ps", (req, res) => {
    res.json({ models: [] });
});

/**
 * OpenAI-compatible endpoints.
 */
app.get("/v1/models", (req, res) => {
    const models = Object.keys(geminiCliModels).map(name => ({
        id: name,
        object: "model",
        created: Date.now(),
        owned_by: "google",
    }));
    res.json({ object: "list", data: models });
});

app.post("/api/chat/completions", (req, res) => {
    const { model, messages, stream = true } = req.body;
    req.body.model = model;
    req.body.messages = messages.map(msg => ({
        role: msg.role,
        content: msg.content
    }));
    req.body.stream = stream;
    processOllamaChat(req, res);
});

app.get("/", (req, res) => res.send("Ollama-Gemini Proxy is running"));

app.listen(OLLAMA_PORT, () => {
    console.log(`Ollama-Gemini proxy listening on http://localhost:${OLLAMA_PORT}`);
});
