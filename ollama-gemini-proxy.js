const express = require("express");
const cors = require("cors");
const { OAuth2Client } = require("google-auth-library");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const readline = require("readline");
const util = require("util");

// --- LOGGING BLOCK (FILE + CONSOLE MIRROR) ---
const fs_log = require("fs");

const DEBUG_LOGGING = process.env.DEBUG_LOGGING === "false";
const logFilePath = path.join(__dirname, ".log");

// Replace the log file on startup
try {
    fs_log.writeFileSync(logFilePath, `--- Log started at ${new Date().toISOString()} ---\n\n`);
    console.log(`[INFO] Log file reset at: ${logFilePath}`);
} catch (err) {
    console.error("[ERROR] Could not write to log file. Check permissions.", err);
}

const logStream = fs_log.createWriteStream(logFilePath, { flags: "a" });

const originalLog = console.log;
const originalDebug = console.debug;
const originalError = console.error;
const originalWarn = console.warn;

const writeToLogAndConsole = (originalFunc, level, args) => {
    const timestamp = new Date().toISOString();
    const formattedMessage = util.format(...args);
    logStream.write(`[${timestamp}] [${level}] ${formattedMessage}\n`);
    if (level === "DEBUG" && !DEBUG_LOGGING) return;
    originalFunc.apply(console, args);
};

console.log = (...args) => writeToLogAndConsole(originalLog, "INFO", args);
console.debug = (...args) => writeToLogAndConsole(originalDebug, "DEBUG", args);
console.error = (...args) => writeToLogAndConsole(originalError, "ERROR", args);
console.warn = (...args) => writeToLogAndConsole(originalWarn, "WARN", args);

console.log("[INFO] Logging configuration loaded. DEBUG_LOGGING is:", DEBUG_LOGGING);
// --- END LOGGING BLOCK ---

// --- SERVER INITIALIZATION ---
console.debug("[DEBUG] Starting proxy server script.");

/** Gemini Code Assist API endpoints and configuration. */
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_API_VERSION = "v1internal";
const OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = "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";
const OAUTH_REDIRECT_URI = "http://localhost:45289";

console.debug("[DEBUG] Loaded configuration constants.", {
    CODE_ASSIST_ENDPOINT,
    CODE_ASSIST_API_VERSION,
    OAUTH_CLIENT_ID,
    OAUTH_REDIRECT_URI,
});

// Gemini CLI-compatible model definitions
const geminiCliModels = {
    "gemini-2.5-pro": { maxTokens: 65536, contextWindow: 1_048_576 },
    "gemini-2.5-flash": { maxTokens: 65536, contextWindow: 1_048_576 },
    "gemini-2.5-flash-non-reasoning": { maxTokens: 65536, contextWindow: 1_048_576 }
};
console.debug("[DEBUG] Configured Gemini CLI models:", geminiCliModels);

/**
 * Handles Gemini Code Assist OAuth2 authentication and API communication.
 */
class GeminiCliHandler {
    constructor(options = {}) {
        console.debug("[DEBUG] Creating new GeminiCliHandler instance.");
        this.options = options;
        this.authClient = new OAuth2Client(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URI);
        this.projectId = null;
        this.authInitialized = false;
    }

    /**
     * Loads OAuth2 credentials from Gemini CLI's default credential file.
     * Throws if credentials are not present.
     */
    async loadOAuthCredentials() {
        console.debug("[DEBUG] Entering loadOAuthCredentials.");
        const credPath = process.env.GEMINI_CLI_OAUTH_PATH || path.join(os.homedir(), ".gemini", "oauth_creds.json");
        try {
            const fileContent = await fs.readFile(credPath, "utf8");
            const credentials = JSON.parse(fileContent);
            return credentials;
        } catch (err) {
            console.error(`[ERROR] Failed to load or parse credentials from ${credPath}.`, err);
            throw new Error(`Failed to load credentials from ${credPath}. Please authenticate with 'gemini auth' first.`);
        }
    }

    /**
     * Initializes OAuth2 authentication and refreshes the token if necessary.
     */
    async initializeAuth(forceRefresh = false) {
        if (this.authInitialized && !forceRefresh && this.authClient.credentials.expiry_date > Date.now()) {
            return;
        }
        const credentials = await this.loadOAuthCredentials();
        this.authClient.setCredentials(credentials);
        // Refresh token if needed
        if (credentials.expiry_date && Date.now() > credentials.expiry_date && credentials.refresh_token) {
            try {
                const { credentials: newCredentials } = await this.authClient.refreshAccessToken();
                this.authClient.setCredentials(newCredentials);
                console.debug("[INFO] OAuth token refreshed.");
            } catch (error) {
                console.error("[ERROR] Failed to refresh OAuth token.", error);
                throw new Error("Failed to refresh OAuth token.");
            }
        }
        this.authInitialized = true;
    }

    /**
     * Discovers or initializes the Gemini projectId for API requests.
     */
    async discoverProjectId() {
        if (this.projectId) return this.projectId;
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
            // Attempt to load existing project
            const loadRequest = { cloudaicompanionProject: initialProjectId, metadata: clientMetadata };
            const loadResponse = await this.authClient.request({
                url: `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:loadCodeAssist`,
                method: "POST", body: JSON.stringify(loadRequest),
            });

            if (loadResponse.data.cloudaicompanionProject) {
                this.projectId = loadResponse.data.cloudaicompanionProject;
                return this.projectId;
            }

            // If not found, trigger onboarding workflow
            const defaultTier = loadResponse.data.allowedTiers?.find(tier => tier.isDefault);
            const tierId = defaultTier?.id || "free-tier";
            const onboardRequest = { tierId, cloudaicompanionProject: initialProjectId, metadata: clientMetadata };
            let lroResponse = await this.authClient.request({
                url: `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:onboardUser`,
                method: "POST", body: JSON.stringify(onboardRequest),
            });

            // Wait for onboarding to complete
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
            console.error("[ERROR] Project ID discovery failed.", error.response?.data || error.message);
            throw new Error("Project ID discovery failed. Ensure you are authenticated and using a personal Google account.");
        }
    }

    /**
     * Parses a Server-Sent Events (SSE) stream, yielding each parsed JSON object.
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
                        console.warn("[WARN] Could not parse SSE JSON fragment, skipping.", e);
                    }
                }
            }
        }
    }

    /**
     * Sends chat messages to Gemini and returns an async iterator of the response stream.
     */
    async createMessage(messages, modelId, temperature = undefined) {
        const projectId = await this.discoverProjectId();
        const modelInfo = geminiCliModels[modelId] || geminiCliModels["gemini-2.5-flash"];

        // Handle "system" messages by prepending to first user message, per Ollama convention
        let adjustedMessages = [];
        let systemPrompt = "";
        if (messages.length > 0 && messages[0].role === "system") {
            systemPrompt = messages[0].content;
            adjustedMessages = messages.slice(1);
        } else {
            adjustedMessages = messages;
        }
        const contents = adjustedMessages.map((msg, index) => {
            let role = msg.role === "assistant" ? "model" : msg.role;
            let textContent = msg.content || "";
            if (index === 0 && role === "user" && systemPrompt) {
                textContent = systemPrompt + "\n\n" + textContent;
            } else if (msg.role === "system") {
                return null; // Ignore non-initial system messages
            }
            return {
                role: role,
                parts: [{ text: textContent }].concat(
                    (msg.images || []).map(base64Img => ({
                        inline_data: { mime_type: "image/jpeg", data: base64Img }
                    }))
                ),
            };
        }).filter(msg => msg !== null);

        if (contents.length === 0) {
            throw new Error("No valid messages to send to the API after filtering/adjustment.");
        }

        const streamRequest = {
            model: modelId === "gemini-2.5-flash-non-reasoning" ? "gemini-2.5-flash" : modelId,
            project: projectId,
            request: {
                contents,
                generationConfig: {
                    maxOutputTokens: modelInfo.maxTokens || 8192,
                    ...(temperature !== undefined && { temperature: temperature }),
                    ...(modelId === "gemini-2.5-flash-non-reasoning" && { thinkingConfig: { thinkingBudget: 0 } })
                },
            },
        };

        try {
            const url = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:streamGenerateContent`;
            const response = await this.authClient.request({
                url: url,
                method: "POST", params: { alt: "sse" }, headers: { "Content-Type": "application/json" },
                responseType: "stream", body: JSON.stringify(streamRequest),
            });
            return this.parseSSEStream(response.data);
        } catch (error) {
            console.error("[ERROR] Error communicating with the Gemini API.", error.response?.data || error.message);
            throw new Error("Error communicating with the Gemini API.");
        }
    }
}

// --- EXPRESS SERVER CONFIGURATION ---
const app = express();
const OLLAMA_PORT = 11434;

app.use(cors());
app.use(express.json({ limit: "80mb" }));

const handler = new GeminiCliHandler();

/**
 * Handles /api/chat and compatible endpoints for Ollama-style chat completions.
 * Supports both streaming and non-streaming responses.
 */
const processOllamaChat = async (req, res) => {
    const { model, messages, stream = true, options } = req.body;
    const modelId = model.replace(":latest", "");

    if (!model || !messages) {
        return res.status(400).json({ error: "Fields 'model' and 'messages' are required." });
    }

    const temperature = options?.temperature;

    try {
        const createdAt = new Date().toISOString();
        const geminiStream = await handler.createMessage(messages, modelId, temperature);

        if (!stream) {
            let fullResponse = "";
            for await (const jsonData of geminiStream) {
                const text = jsonData.response?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) fullResponse += text;
            }
            const ollamaResponse = { model, created_at: createdAt, message: { role: "assistant", content: fullResponse }, done: true };
            return res.json(ollamaResponse);
        }

        // Streaming mode
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
        console.error(`[ERROR] Error processing chat request: ${error.message}`, error.stack);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        } else if (!res.writableEnded) {
            res.end();
        }
    }
};

// --- OLLAMA-COMPATIBLE ENDPOINTS ---
app.post("/api/chat", processOllamaChat);

app.post("/api/generate", (req, res) => {
    const { model, prompt, images = [] } = req.body;
    if (!prompt) {
        return res.status(400).json({ error: "Field 'prompt' is required." });
    }
    req.body.messages = [{ role: "user", content: prompt, images }];
    processOllamaChat(req, res);
});

app.get("/api/tags", (req, res) => {
    const models = Object.keys(geminiCliModels).map(name => ({ name: `${name}:latest`, model: `${name}:latest` }));
    res.json({ models });
});

// Simulated endpoint for compatibility with Open WebUI
app.get("/api/ps", (req, res) => {
    res.json({ models: [] });
});

// /api/show returns model metadata in Ollama format, excluding "completion" in capabilities
app.post("/api/show", (req, res) => {
    const { name } = req.body;
    const modelId = name ? name.replace(":latest", "") : null;
    const modelInfo = geminiCliModels[modelId];
    if (!modelInfo) {
        return res.status(404).json({ error: "Model not found" });
    }
    const ollamaShowResponse = {
        modelfile: `FROM ${modelId}`,
        parameters: `stop_token: <tool_code>\nstop_token: </tool_code>\nstop_token: <thinking>\nstop_token: </thinking>`,
        template: "{{- if .System}}\n{{.System}}\n{{- end}}\n{{- if .Prompt}}\n{{.Prompt}}\n{{- end}}",
        model_info: {
            family: "gemini",
            architecture: "flash",
        },
        capabilities: ["vision"],
        details: {
            format: "gguf",
            family: "gemini",
            parameter_size: "N/A",
            quantization_level: "N/A",
        },
        license: "Apache 2.0 (Google Gemini CLI attribution)",
    };
    res.json(ollamaShowResponse);
});

// --- OPENAI-COMPATIBLE ENDPOINTS ---
app.get("/v1/models", (req, res) => {
    const models = Object.keys(geminiCliModels).map(name => ({
        id: name,
        object: "model",
        created: Date.now(),
        owned_by: "google",
    }));
    res.json({ object: "list", data: models });
});

app.post("/v1/chat/completions", (req, res) => {
    processOllamaChat(req, res);
});

app.post("/api/chat/completions", (req, res) => {
    processOllamaChat(req, res);
});

// Healthcheck
app.get("/", (req, res) => {
    res.send("Ollama-Gemini Proxy is running");
});

app.listen(OLLAMA_PORT, () => {
    console.log(`Ollama-Gemini proxy listening at http://localhost:${OLLAMA_PORT}`);
    console.log("Server ready to receive requests. Enable DEBUG_LOGGING=true for detailed trace.");
});
