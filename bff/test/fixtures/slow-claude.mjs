#!/usr/bin/env node
// Fake claude CLI for abort tests: prints one partial delta then hangs.
process.stdout.write(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } }) + "\n");
setInterval(() => {}, 1000);
