// server.ts
import express from 'express';
import { fal } from '@fal-ai/client';

// 初始化 FAL 客户端
const fal = new FalClient({
  credentials: Deno.env.get("FAL_KEY") || "",
});

// 环境变量检查
const FAL_KEY = Deno.env.get("FAL_KEY");
const API_KEY = Deno.env.get("API_KEY");

if (!FAL_KEY) {
  console.error("Error: FAL_KEY environment variable is not set.");
  Deno.exit(1);
}

if (!API_KEY) {
  console.error("Error: API_KEY environment variable is not set.");
  Deno.exit(1);
}

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
  "meta-llama/llama-4-scout",
];

// Helper function to get owner from model ID
const getOwner = (modelId: string) => {
  if (modelId && modelId.includes("/")) {
    return modelId.split("/")[0];
  }
  return "fal-ai";
};

// API Key 鉴权函数
const validateApiKey = (request: Request): boolean => {
  const authHeader = request.headers.get("authorization");
  
  if (!authHeader) {
    console.warn("Unauthorized: No Authorization header provided");
    return false;
  }
  
  const authParts = authHeader.split(" ");
  if (authParts.length !== 2 || authParts[0].toLowerCase() !== "bearer") {
    console.warn("Unauthorized: Invalid Authorization header format");
    return false;
  }
  
  const providedKey = authParts[1];
  return providedKey === API_KEY;
};

// === 消息转换函数 ===
function convertMessagesToFalPrompt(messages: any[]) {
  let fixed_system_prompt_content = "";
  const conversation_message_blocks: string[] = [];
  console.log(`Original messages count: ${messages.length}`);

  // 1. 分离 System 消息，格式化 User/Assistant 消息
  for (const message of messages) {
    let content = (message.content === null || message.content === undefined) ? "" : String(message.content);
    switch (message.role) {
      case "system":
        fixed_system_prompt_content += `System: ${content}\n\n`;
        break;
      case "user":
        conversation_message_blocks.push(`Human: ${content}\n\n`);
        break;
      case "assistant":
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
  let space_occupied_by_fixed_system = 0;
  if (fixed_system_prompt_content.length > 0) {
    space_occupied_by_fixed_system = fixed_system_prompt_content.length + 4; // 预留 \n\n...\n\n 的长度
  }
  const remaining_system_limit = Math.max(0, SYSTEM_PROMPT_LIMIT - space_occupied_by_fixed_system);
  console.log(`Trimmed fixed system prompt length: ${fixed_system_prompt_content.length}. Approx remaining system history limit: ${remaining_system_limit}`);

  // 4. 反向填充 User/Assistant 对话历史
  const prompt_history_blocks: string[] = [];
  const system_prompt_history_blocks: string[] = [];
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

  // 5. 组合最终的 prompt 和 system_prompt (包含分隔符逻辑)
  const system_prompt_history_content = system_prompt_history_blocks.join("").trim();
  const final_prompt = prompt_history_blocks.join("").trim();

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

  // 6. 返回结果
  const result = {
    system_prompt: final_system_prompt, // 最终结果不需要再 trim
    prompt: final_prompt              // final_prompt 在组合前已 trim
  };

  console.log(`Final system_prompt length (Sys+Separator+Hist): ${result.system_prompt.length}`);
  console.log(`Final prompt length (Hist): ${result.prompt.length}`);

  return result;
}

// 主处理函数
async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  console.log(`Received request: ${request.method} ${path}`);

  // 处理根路径请求
  if (path === "/" && request.method === "GET") {
    return new Response("Fal OpenAI Proxy (System Top + Separator + Recency Strategy) is running.", {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    });
  }

  // API Key 验证
  if (["/v1/models", "/v1/chat/completions"].includes(path) && !validateApiKey(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized: Invalid API Key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 列出模型接口
  if (path === "/v1/models" && request.method === "GET") {
    console.log("Handling GET /v1/models request");
    try {
      const modelsData = FAL_SUPPORTED_MODELS.map(modelId => ({
        id: modelId, object: "model", created: 1700000000, owned_by: getOwner(modelId)
      }));
      return new Response(JSON.stringify({ object: "list", data: modelsData }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (error) {
      console.error("Error processing GET /v1/models:", error);
      return new Response(JSON.stringify({ error: "Failed to retrieve model list." }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // 聊天完成接口
  if (path === "/v1/chat/completions" && request.method === "POST") {
    try {
      const requestBody = await request.json();
      const { model, messages, stream = false, reasoning = false } = requestBody;

      console.log(`Received chat completion request for model: ${model}, stream: ${stream}`);

      if (!FAL_SUPPORTED_MODELS.includes(model)) {
        console.warn(`Warning: Requested model '${model}' is not in the explicitly supported list.`);
      }
      
      if (!model || !messages || !Array.isArray(messages) || messages.length === 0) {
        console.error("Invalid request parameters:", { model, messages: Array.isArray(messages) ? messages.length : typeof messages });
        return new Response(JSON.stringify({ error: "Missing or invalid parameters: model and messages array are required." }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      // 使用更新后的转换函数
      const { prompt, system_prompt } = convertMessagesToFalPrompt(messages);

      const falInput = {
        model: model,
        prompt: prompt,
        ...(system_prompt && { system_prompt: system_prompt }),
        reasoning: !!reasoning,
      };

      console.log("Fal Input:", JSON.stringify(falInput, null, 2));
      console.log("System Prompt Length:", system_prompt?.length || 0);
      console.log("Prompt Length:", prompt?.length || 0);

      // 非流式处理
      if (!stream) {
        console.log("Executing non-stream request...");
        const result = await fal.subscribe("fal-ai/any-llm", { input: falInput, logs: true });
        console.log("Received non-stream result from fal-ai:", JSON.stringify(result, null, 2));

        if (result && result.error) {
          console.error("Fal-ai returned an error in non-stream mode:", result.error);
          return new Response(JSON.stringify({ 
            object: "error", 
            message: `Fal-ai error: ${JSON.stringify(result.error)}`, 
            type: "fal_ai_error", 
            param: null, 
            code: null 
          }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }

        const openAIResponse = {
          id: `chatcmpl-${result.requestId || Date.now()}`, 
          object: "chat.completion", 
          created: Math.floor(Date.now() / 1000), 
          model: model,
          choices: [{ 
            index: 0, 
            message: { role: "assistant", content: result.output || "" }, 
            finish_reason: "stop" 
          }],
          usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null }, 
          system_fingerprint: null,
          ...(result.reasoning && { fal_reasoning: result.reasoning }),
        };
        
        return new Response(JSON.stringify(openAIResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } 
      // 流式处理
      else {
        const stream = new TransformStream();
        const writer = stream.writable.getWriter();
        
        // 设置响应头
        const headers = new Headers({
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*"
        });

        // 启动异步处理流
        (async () => {
          try {
            let previousOutput = '';
            const falStream = await fal.stream("fal-ai/any-llm", { input: falInput });

            for await (const event of falStream) {
              const currentOutput = (event && typeof event.output === 'string') ? event.output : '';
              const isPartial = (event && typeof event.partial === 'boolean') ? event.partial : true;
              const errorInfo = (event && event.error) ? event.error : null;

              if (errorInfo) {
                console.error("Error received in fal stream event:", errorInfo);
                const errorChunk = { 
                  id: `chatcmpl-${Date.now()}-error`, 
                  object: "chat.completion.chunk", 
                  created: Math.floor(Date.now() / 1000), 
                  model: model, 
                  choices: [{ 
                    index: 0, 
                    delta: {}, 
                    finish_reason: "error", 
                    message: { 
                      role: 'assistant', 
                      content: `Fal Stream Error: ${JSON.stringify(errorInfo)}` 
                    } 
                  }] 
                };
                await writer.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                break;
              }

              let deltaContent = '';
              if (currentOutput.startsWith(previousOutput)) {
                deltaContent = currentOutput.substring(previousOutput.length);
              } else if (currentOutput.length > 0) {
                console.warn("Fal stream output mismatch detected. Sending full current output as delta.", 
                  { previousLength: previousOutput.length, currentLength: currentOutput.length });
                deltaContent = currentOutput;
                previousOutput = '';
              }
              previousOutput = currentOutput;

              if (deltaContent || !isPartial) {
                const openAIChunk = { 
                  id: `chatcmpl-${Date.now()}`, 
                  object: "chat.completion.chunk", 
                  created: Math.floor(Date.now() / 1000), 
                  model: model, 
                  choices: [{ 
                    index: 0, 
                    delta: { content: deltaContent }, 
                    finish_reason: isPartial === false ? "stop" : null 
                  }] 
                };
                await writer.write(`data: ${JSON.stringify(openAIChunk)}\n\n`);
              }
            }
            
            await writer.write(`data: [DONE]\n\n`);
            await writer.close();
            console.log("Stream finished.");
            
          } catch (error) {
            console.error('Error during fal stream processing:', error);
            try {
              const errorDetails = (error instanceof Error) ? error.message : JSON.stringify(error);
              await writer.write(`data: ${JSON.stringify({ 
                error: { 
                  message: "Stream processing error", 
                  type: "proxy_error", 
                  details: errorDetails 
                } 
              })}\n\n`);
              await writer.write(`data: [DONE]\n\n`);
              await writer.close();
            } catch (finalError) {
              console.error('Error sending stream error message to client:', finalError);
              await writer.close();
            }
          }
        })();

        return new Response(stream.readable, { headers });
      }
    } catch (error) {
      console.error('Unhandled error in /v1/chat/completions:', error);
      return new Response(JSON.stringify({ 
        error: 'Internal Server Error in Proxy', 
        details: error instanceof Error ? error.message : String(error) 
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // 处理 OPTIONS 请求 (CORS 预检请求)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // 如果没有匹配到任何路由，返回 404
  return new Response("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain" }
  });
}

// 启动服务器
const PORT = Number(Deno.env.get("PORT")) || 3000;
console.log(`===================================================`);
console.log(` Fal OpenAI Proxy Server (System Top + Separator + Recency)`);
console.log(` Listening on port: ${PORT}`);
console.log(` Using Limits: System Prompt=${SYSTEM_PROMPT_LIMIT}, Prompt=${PROMPT_LIMIT}`);
console.log(` Fal AI Key Loaded: ${FAL_KEY ? 'Yes' : 'No'}`);
console.log(` API Key Auth Enabled: ${API_KEY ? 'Yes' : 'No'}`);
console.log(` Chat Completions Endpoint: POST http://localhost:${PORT}/v1/chat/completions`);
console.log(` Models Endpoint: GET http://localhost:${PORT}/v1/models`);
console.log(`===================================================`);

serve(handler, { port: PORT });
