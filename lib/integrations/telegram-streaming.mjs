/**
 * Telegram Native Streaming Handler
 * Uses sendMessageDraft (Bot API 9.5) for progressive text display
 */

/**
 * Stream LLM response progressively to Telegram using sendMessageDraft
 * @param {number} chatId - Telegram chat ID
 * @param {number|null} threadId - Topic ID (if in forum group)
 * @param {string} targetAgent - Agent identifier (for logging)
 * @param {Object} provider - Provider config { baseUrl, apiKey }
 * @param {string} modelId - Model identifier
 * @param {Array} messages - Message array for LLM
 * @param {Function} tgRequest - Telegram API request function
 * @param {Function} log - Logger function
 * @returns {Promise<string>} Final response text
 */
export async function streamToTelegram({
  chatId,
  threadId = null,
  targetAgent,
  provider,
  modelId,
  messages,
  tgRequest,
  log
}) {
  const draftId = Date.now(); // Unique draft ID for this stream
  let fullText = "";
  let lastUpdate = 0;
  const UPDATE_INTERVAL_MS = 100; // Update every 100ms (smooth but not spammy)
  
  try {
    // Call LLM with streaming enabled
    const response = await fetch(provider.baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: 0.7,
        stream: true // Enable streaming
      })
    });
    
    if (!response.ok) {
      throw new Error(`LLM API returned ${response.status}`);
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      
      for (const line of lines) {
        if (!line.trim() || !line.startsWith("data: ")) continue;
        
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          
          if (content) {
            fullText += content;
            
            // Throttle updates - only send every 100ms
            const now = Date.now();
            if (now - lastUpdate >= UPDATE_INTERVAL_MS) {
              await tgRequest("sendMessageDraft", {
                chat_id: chatId,
                ...(threadId && { message_thread_id: threadId }),
                draft_id: draftId,
                text: fullText,
                parse_mode: "Markdown"
              }).catch(err => {
                // Fallback: if Markdown fails, try without parse_mode
                return tgRequest("sendMessageDraft", {
                  chat_id: chatId,
                  ...(threadId && { message_thread_id: threadId }),
                  draft_id: draftId,
                  text: fullText
                });
              });
              
              lastUpdate = now;
            }
          }
        } catch (parseErr) {
          log("warn", "Failed to parse SSE chunk", { error: parseErr.message });
        }
      }
    }
    
    // Send final update (in case last chunk didn't trigger threshold)
    if (fullText && Date.now() - lastUpdate >= 50) {
      await tgRequest("sendMessageDraft", {
        chat_id: chatId,
        ...(threadId && { message_thread_id: threadId }),
        draft_id: draftId,
        text: fullText,
        parse_mode: "Markdown"
      }).catch(err => {
        return tgRequest("sendMessageDraft", {
          chat_id: chatId,
          ...(threadId && { message_thread_id: threadId }),
          draft_id: draftId,
          text: fullText
        });
      });
    }
    
    log("info", "Streaming complete", { 
      targetAgent, 
      chatId, 
      threadId, 
      length: fullText.length 
    });
    
    return fullText;
    
  } catch (err) {
    log("error", "Streaming failed", { 
      targetAgent, 
      error: err.message 
    });
    throw err;
  }
}

/**
 * Check if native streaming is supported for this chat
 * sendMessageDraft only works in private chats (DMs and private topics)
 * @param {number} chatId - Telegram chat ID
 * @returns {boolean}
 */
export function supportsNativeStreaming(chatId) {
  // Private chats have positive IDs
  // Groups/supergroups have negative IDs
  // BUT: Private chats with topics ARE supported
  return chatId > 0;
}
