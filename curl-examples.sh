#!/usr/bin/env bash
# curl examples for the local ChatGPT bridge API.
# Usage: ./curl-examples.sh [health|models|chat|new|stream|system|history|params|n|image <file>|ask "your prompt"]
# By default requests continue the current ChatGPT chat; "new_chat": true starts a fresh one.
#   API_KEY=sk-... BASE_URL=http://127.0.0.1:8765 ./curl-examples.sh chat

BASE_URL="${BASE_URL:-http://127.0.0.1:8765}"
# API key: $API_KEY, else server/.env (written by start.bash).
if [ -z "${API_KEY:-}" ] && [ -f "$(dirname "$0")/server/.env" ]; then
  API_KEY="$(grep -E '^API_KEY=' "$(dirname "$0")/server/.env" | cut -d= -f2)"
fi
API_KEY="${API_KEY:?Set API_KEY or run ./start.bash first}"

post() {
  curl -sS "$@" "$BASE_URL/v1/chat/completions" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json"
}

case "${1:-chat}" in
  health)
    # No auth needed: shows whether the extension is connected.
    curl -sS "$BASE_URL/health"
    ;;
  models)
    curl -sS "$BASE_URL/v1/models" -H "Authorization: Bearer $API_KEY"
    ;;
  chat)
    # Simple one-shot message.
    post -d '{
      "model": "chatgpt-web",
      "messages": [{"role": "user", "content": "Hi! In 2 short sentences, what can you help me with?"}]
    }'
    ;;
  new)
    # Start a fresh ChatGPT chat for this request.
    post -d '{
      "model": "chatgpt-web",
      "new_chat": true,
      "messages": [{"role": "user", "content": "Let us start a new topic: explain REST in one sentence."}]
    }'
    ;;
  stream)
    # Server-sent events, OpenAI chunk format. -N disables buffering.
    post -N -d '{
      "model": "chatgpt-web",
      "stream": true,
      "messages": [{"role": "user", "content": "Write a haiku about APIs."}]
    }'
    ;;
  system)
    # System prompt + user message.
    post -d '{
      "model": "chatgpt-web",
      "messages": [
        {"role": "system", "content": "You are a senior Python reviewer. Be concise."},
        {"role": "user", "content": "Is `except Exception: pass` ok?"}
      ]
    }'
    ;;
  history)
    # Multi-turn conversation: earlier turns are sent as context.
    post -d '{
      "model": "chatgpt-web",
      "messages": [
        {"role": "user", "content": "My favorite color is teal."},
        {"role": "assistant", "content": "Noted."},
        {"role": "user", "content": "What is my favorite color? One word."}
      ]
    }'
    ;;
  params)
    # Length cap, stop sequence, low temperature, Think mode for the new chat.
    post -d '{
      "new_chat": true,
      "max_tokens": 120,
      "stop": ["\n\n"],
      "temperature": 0.2,
      "reasoning_effort": "high",
      "messages": [{"role": "user", "content": "Explain what an API gateway does."}]
    }'
    ;;
  n)
    # Two alternative answers, each in its own chat (needs 2 chatgpt.com tabs to run in parallel).
    post -d '{
      "n": 2,
      "messages": [{"role": "user", "content": "Suggest a name for a coffee shop. Just the name."}]
    }'
    ;;
  image)
    # Image input: ./curl-examples.sh image photo.png
    file="${2:?Usage: ./curl-examples.sh image <file>}"
    body=$(python3 -c 'import base64,json,mimetypes,sys
p=sys.argv[1]; mime=mimetypes.guess_type(p)[0] or "image/png"
b64=base64.b64encode(open(p,"rb").read()).decode()
print(json.dumps({"new_chat": True, "messages":[{"role":"user","content":[
  {"type":"text","text":"Describe this image in two sentences."},
  {"type":"image_url","image_url":{"url":f"data:{mime};base64,{b64}"}}]}]}))' "$file")
    post -d "$body"
    ;;
  ask)
    # Any prompt from the command line; prints just the reply text.
    shift
    prompt="$*"
    [ -z "$prompt" ] && { echo 'Usage: ./curl-examples.sh ask "your prompt"' >&2; exit 1; }
    body=$(python3 -c 'import json,sys; print(json.dumps({"model":"chatgpt-web","messages":[{"role":"user","content":sys.argv[1]}]}))' "$prompt")
    post -d "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["choices"][0]["message"]["content"] if "choices" in d else d)'
    ;;
  *)
    echo "Unknown example: $1 (use health|models|chat|new|stream|system|history|params|n|image|ask)" >&2
    exit 1
    ;;
esac
echo
