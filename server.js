import express from 'express';
import { fal } from '@fal-ai/client';

// 从环境变量读取 Fal AI API Key 和自定义 API Key
const FAL_KEY = process.env.FAL_KEY;
const API_KEY = process.env.API_KEY; // 添加自定义 API Key 环境变量

if (!FAL_KEY) {
    console.error("Error: FAL_KEY environment variable is not set.");
    process.exit(1);
}

if (!API_KEY) {
    console.error("Error: API_KEY environment variable is not set.");
    process.exit(1);
}

// 配置 fal 客户端
fal.config({
    credentials: FAL_KEY,
});

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const PORT = process.env.PORT || 3000;

// API Key 鉴权中间件
const apiKeyAuth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    
    if (!authHeader) {
        console.warn('Unauthorized: No Authorization header provided');
        return res.status(401).json({ error: 'Unauthorized: No API Key provided' });
    }
    
    const authParts = authHeader.split(' ');
    if (authParts.length !== 2 || authParts[0].toLowerCase() !== 'bearer') {
        console.warn('Unauthorized: Invalid Authorization header format');
        return res.status(401).json({ error: 'Unauthorized: Invalid Authorization header format' });
    }
    
    const providedKey = authParts[1];
    if (providedKey !== API_KEY) {
        console.warn('Unauthorized: Invalid API Key');
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }
    
    next();
};

// 应用 API Key 鉴权中间件到所有 API 路由
app.use(['/v1/models', '/v1/chat/completions'], apiKeyAuth);

// === 全局定义限制 ===
const PROMPT_LIMIT = 4800;
const SYSTEM_PROMPT_LIMIT = 4800;
// === 限制定义结束 ===

// 定义 fal-ai/any-llm 支持的模型列表
const FAL_SUPPORTED_MODELS = [
    "anthropic/claude-3.7-sonnet",
    "anthropic/claude-3.5-sonnet",
    "anthropic/claude-3-5-haiku",
    "anthropic/claude-3-haiku",
    "google/gemini-pro-1.5",
    "google/gemini-flash-1.5",
    "google/gemini-flash-1.5-8b",
    "google/gemini-2.0-flash-001",
    "meta-llama/llama-3.2-1b-instruct",
    "meta-llama/llama-3.2-3b-instruct",
    "meta-llama/llama-3.1-8b-instruct",
    "meta-llama/llama-3.1-70b-instruct",
    "openai/gpt-4o-mini",
    "openai/gpt-4o",
    "deepseek/deepseek-r1",
    "meta-llama/llama-4-maverick",
    "meta-llama/llama-4-scout"
];

// Helper function to get owner from model ID
const getOwner = (modelId) => {
    if (modelId && modelId.includes('/')) {
        return modelId.split('/')[0];
    }
    return 'fal-ai';
}

// GET /v1/models endpoint
app.get('/v1/models', (req, res) => {
    console.log("Received request for GET /v1/models");
    try {
        const modelsData = FAL_SUPPORTED_MODELS.map(modelId => ({
            id: modelId, object: "model", created: 1700000000, owned_by: getOwner(modelId)
        }));
        res.json({ object: "list", data: modelsData });
        console.log("Successfully returned model list.");
    } catch (error) {
        console.error("Error processing GET /v1/models:", error);
        res.status(500).json({ error: "Failed to retrieve model list." });
    }
});

// === 修改后的 convertMessagesToFalPrompt 函数 (System置顶 + 分隔符 + 对话历史Recency) ===
function convertMessagesToFalPrompt(messages) {
    let fixed_system_prompt_content = "";
    const conversation_message_blocks = [];
    console.log(`Original messages count: ${messages.length}`);

    // 1. 分离 System 消息，格式化 User/Assistant 消息
    for (const message of messages) {
        let content = (message.content === null || message.content === undefined) ? "" : String(message.content);
        switch (message.role) {
            case 'system':
                fixed_system_prompt_content += `System: ${content}\n\n`;
                break;
            case 'user':
                conversation_message_blocks.push(`Human: ${content}\n\n`);
                break;
            case 'assistant':
                conversation_message_blocks.push(`Assistant: ${content}\n\n`);
                break;
            default:
                console.warn(`Unsupported role: ${message.role}`);
                continue;
        }
    }

    // 2. 截断合并后的 system 消息（如果超长）
    if (fixed_system_prompt_content.length > SYSTEM_PROMPT_LIMIT) {
        const originalLength = fixed_system_prompt_content.length;
        fixed_system_prompt_content = fixed_system_prompt_content.substring(0, SYSTEM_PROMPT_LIMIT);
        console.warn(`Combined system messages truncated from ${originalLength} to ${SYSTEM_PROMPT_LIMIT}`);
    }
    // 清理末尾可能多余的空白，以便后续判断和拼接
    fixed_system_prompt_content = fixed_system_prompt_content.trim();


    // 3. 计算 system_prompt 中留给对话历史的剩余空间
    // 注意：这里计算时要考虑分隔符可能占用的长度，但分隔符只在需要时添加
    // 因此先计算不含分隔符的剩余空间
    let space_occupied_by_fixed_system = 0;
    if (fixed_system_prompt_content.length > 0) {
        // 如果固定内容不为空，计算其长度 + 后面可能的分隔符的长度（如果需要）
        // 暂时只计算内容长度，分隔符在组合时再考虑
         space_occupied_by_fixed_system = fixed_system_prompt_content.length + 4; // 预留 \n\n...\n\n 的长度
    }
     const remaining_system_limit = Math.max(0, SYSTEM_PROMPT_LIMIT - space_occupied_by_fixed_system);
    console.log(`Trimmed fixed system prompt length: ${fixed_system_prompt_content.length}. Approx remaining system history limit: ${remaining_system_limit}`);


    // 4. 反向填充 User/Assistant 对话历史
    const prompt_history_blocks = [];
    const system_prompt_history_blocks = [];
    let current_prompt_length = 0;
    let current_system_history_length = 0;
    let promptFull = false;
    let systemHistoryFull = (remaining_system_limit <= 0);

    console.log(`Processing ${conversation_message_blocks.length} user/assistant messages for recency filling.`);
    for (let i = conversation_message_blocks.length - 1; i >= 0; i--) {
        const message_block = conversation_message_blocks[i];
        const block_length = message_block.length;

        if (promptFull && systemHistoryFull) {
            console.log(`Both prompt and system history slots full. Omitting older messages from index ${i}.`);
            break;
        }

        // 优先尝试放入 prompt
        if (!promptFull) {
            if (current_prompt_length + block_length <= PROMPT_LIMIT) {
                prompt_history_blocks.unshift(message_block);
                current_prompt_length += block_length;
                continue;
            } else {
                promptFull = true;
                console.log(`Prompt limit (${PROMPT_LIMIT}) reached. Trying system history slot.`);
            }
        }

        // 如果 prompt 满了，尝试放入 system_prompt 的剩余空间
        if (!systemHistoryFull) {
            if (current_system_history_length + block_length <= remaining_system_limit) {
                 system_prompt_history_blocks.unshift(message_block);
                 current_system_history_length += block_length;
                 continue;
            } else {
                 systemHistoryFull = true;
                 console.log(`System history limit (${remaining_system_limit}) reached.`);
            }
        }
    }

    // 5. *** 组合最终的 prompt 和 system_prompt (包含分隔符逻辑) ***
    const system_prompt_history_content = system_prompt_history_blocks.join('').trim();
    const final_prompt = prompt_history_blocks.join('').trim();

    // 定义分隔符
    const SEPARATOR = "\n\n-------下面是比较早之前的对话内容-----\n\n";

    let final_system_prompt = "";

    // 检查各部分是否有内容 (使用 trim 后的固定部分)
    const hasFixedSystem = fixed_system_prompt_content.length > 0;
    const hasSystemHistory = system_prompt_history_content.length > 0;

    if (hasFixedSystem && hasSystemHistory) {
        // 两部分都有，用分隔符连接
        final_system_prompt = fixed_system_prompt_content + SEPARATOR + system_prompt_history_content;
        console.log("Combining fixed system prompt and history with separator.");
    } else if (hasFixedSystem) {
        // 只有固定部分
        final_system_prompt = fixed_system_prompt_content;
        console.log("Using only fixed system prompt.");
    } else if (hasSystemHistory) {
        // 只有历史部分 (固定部分为空)
        final_system_prompt = system_prompt_history_content;
        console.log("Using only history in system prompt slot.");
    }
    // 如果两部分都为空，final_system_prompt 保持空字符串 ""

    // 6. 返回结果
    const result = {
        system_prompt: final_system_prompt, // 最终结果不需要再 trim
        prompt: final_prompt              // final_prompt 在组合前已 trim
    };

    console.log(`Final system_prompt length (Sys+Separator+Hist): ${result.system_prompt.length}`);
    console.log(`Final prompt length (Hist): ${result.prompt.length}`);

    return result;
}
// === convertMessagesToFalPrompt 函数结束 ===


// POST /v1/chat/completions endpoint (保持不变)
app.post('/v1/chat/completions', async (req, res) => {
    const { model, messages, stream = false, reasoning = false, ...restOpenAIParams } = req.body;

    console.log(`Received chat completion request for model: ${model}, stream: ${stream}`);

    if (!FAL_SUPPORTED_MODELS.includes(model)) {
         console.warn(`Warning: Requested model '${model}' is not in the explicitly supported list.`);
    }
    if (!model || !messages || !Array.isArray(messages) || messages.length === 0) {
        console.error("Invalid request parameters:", { model, messages: Array.isArray(messages) ? messages.length : typeof messages });
        return res.status(400).json({ error: 'Missing or invalid parameters: model and messages array are required.' });
    }

    try {
        // *** 使用更新后的转换函数 ***
        const { prompt, system_prompt } = convertMessagesToFalPrompt(messages);

        const falInput = {
            model: model,
            prompt: prompt,
            ...(system_prompt && { system_prompt: system_prompt }),
            reasoning: !!reasoning,
        };
	console.log("Fal Input:", JSON.stringify(falInput, null, 2));
        console.log("Forwarding request to fal-ai with system-priority + separator + recency input:");
        console.log("System Prompt Length:", system_prompt?.length || 0);
        console.log("Prompt Length:", prompt?.length || 0);
        // 调试时取消注释可以查看具体内容
        console.log("--- System Prompt Start ---");
        console.log(system_prompt);
        console.log("--- System Prompt End ---");
        console.log("--- Prompt Start ---");
        console.log(prompt);
        console.log("--- Prompt End ---");


        // --- 流式/非流式处理逻辑 (保持不变) ---
        if (stream) {
            // ... 流式代码 ...
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.flushHeaders();

            let previousOutput = '';

            const falStream = await fal.stream("fal-ai/any-llm", { input: falInput });

            try {
                for await (const event of falStream) {
                    const currentOutput = (event && typeof event.output === 'string') ? event.output : '';
                    const isPartial = (event && typeof event.partial === 'boolean') ? event.partial : true;
                    const errorInfo = (event && event.error) ? event.error : null;

                    if (errorInfo) {
                        console.error("Error received in fal stream event:", errorInfo);
                        const errorChunk = { id: `chatcmpl-${Date.now()}-error`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model, choices: [{ index: 0, delta: {}, finish_reason: "error", message: { role: 'assistant', content: `Fal Stream Error: ${JSON.stringify(errorInfo)}` } }] };
                        res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                        break;
                    }

                    let deltaContent = '';
                    if (currentOutput.startsWith(previousOutput)) {
                        deltaContent = currentOutput.substring(previousOutput.length);
                    } else if (currentOutput.length > 0) {
                        console.warn("Fal stream output mismatch detected. Sending full current output as delta.", { previousLength: previousOutput.length, currentLength: currentOutput.length });
                        deltaContent = currentOutput;
                        previousOutput = '';
                    }
                    previousOutput = currentOutput;

                    if (deltaContent || !isPartial) {
                        const openAIChunk = { id: `chatcmpl-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model, choices: [{ index: 0, delta: { content: deltaContent }, finish_reason: isPartial === false ? "stop" : null }] };
                        res.write(`data: ${JSON.stringify(openAIChunk)}\n\n`);
                    }
                }
                res.write(`data: [DONE]\n\n`);
                res.end();
                console.log("Stream finished.");

            } catch (streamError) {
                console.error('Error during fal stream processing loop:', streamError);
                try {
                    const errorDetails = (streamError instanceof Error) ? streamError.message : JSON.stringify(streamError);
                    res.write(`data: ${JSON.stringify({ error: { message: "Stream processing error", type: "proxy_error", details: errorDetails } })}\n\n`);
                    res.write(`data: [DONE]\n\n`);
                    res.end();
                } catch (finalError) {
                    console.error('Error sending stream error message to client:', finalError);
                    if (!res.writableEnded) { res.end(); }
                }
            }
        } else {
            // --- 非流式处理 (保持不变) ---
            console.log("Executing non-stream request...");
            const result = await fal.subscribe("fal-ai/any-llm", { input: falInput, logs: true });
            console.log("Received non-stream result from fal-ai:", JSON.stringify(result, null, 2));

            if (result && result.error) {
                 console.error("Fal-ai returned an error in non-stream mode:", result.error);
                 return res.status(500).json({ object: "error", message: `Fal-ai error: ${JSON.stringify(result.error)}`, type: "fal_ai_error", param: null, code: null });
            }

            const openAIResponse = {
                id: `chatcmpl-${result.requestId || Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: model,
                choices: [{ index: 0, message: { role: "assistant", content: result.output || "" }, finish_reason: "stop" }],
                usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null }, system_fingerprint: null,
                ...(result.reasoning && { fal_reasoning: result.reasoning }),
            };
            res.json(openAIResponse);
            console.log("Returned non-stream response.");
        }

    } catch (error) {
        console.error('Unhandled error in /v1/chat/completions:', error);
        if (!res.headersSent) {
            const errorMessage = (error instanceof Error) ? error.message : JSON.stringify(error);
            res.status(500).json({ error: 'Internal Server Error in Proxy', details: errorMessage });
        } else if (!res.writableEnded) {
             console.error("Headers already sent, ending response.");
             res.end();
        }
    }
});

// 启动服务器 (更新启动信息)
app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(` Fal OpenAI Proxy Server (System Top + Separator + Recency)`);
    console.log(` Listening on port: ${PORT}`);
    console.log(` Using Limits: System Prompt=${SYSTEM_PROMPT_LIMIT}, Prompt=${PROMPT_LIMIT}`);
    console.log(` Fal AI Key Loaded: ${FAL_KEY ? 'Yes' : 'No'}`);
    console.log(` API Key Auth Enabled: ${API_KEY ? 'Yes' : 'No'}`);
    console.log(` Chat Completions Endpoint: POST http://localhost:${PORT}/v1/chat/completions`);
    console.log(` Models Endpoint: GET http://localhost:${PORT}/v1/models`);
    console.log(`===================================================`);
});

// 根路径响应 (更新信息)
app.get('/', (req, res) => {
    res.send('Fal OpenAI Proxy (System Top + Separator + Recency Strategy) is running.');
});
