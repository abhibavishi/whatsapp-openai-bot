const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const os = require('os');

require('dotenv').config();

const ASSISTANT_ID = process.env.ASSISTANT_ID;
const THREADS_FILE = process.env.THREADS_FILE;
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const client = new Client({
  authStrategy: new LocalAuth(),
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2410.1.html',
  }
});

// Load or initialize thread storage
const loadThreads = () => {
  try {
    return JSON.parse(fs.readFileSync(THREADS_FILE, 'utf8'));
  } catch (e) {
    console.log('Starting with an empty thread store.');
    return {};
  }
};

const saveThreads = (threads) => {
  fs.writeFileSync(THREADS_FILE, JSON.stringify(threads, null, 2));
};

let contactThreads = loadThreads();

client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('Client is ready!');
});

client.on('message', async (message) => {
  console.log(`Received message from ${message.from}: ${message.body}`);
  try {
    await handleIncomingMessage(message);
  } catch (error) {
    console.error(`Error handling message from ${message.from}:`, error);
  }
});

async function uploadImageToOpenAI(media) {
  const tempFilePath = path.join(os.tmpdir(), `upload_${Date.now()}.jpg`);
  try {
    await fs.promises.writeFile(tempFilePath, Buffer.from(media.data, 'base64'));

    const file = await openai.files.create({
      file: fs.createReadStream(tempFilePath),
      purpose: 'assistants'
    });

    await fs.promises.unlink(tempFilePath);

    return file.id;
  } catch (error) {
    if (fs.existsSync(tempFilePath)) {
      await fs.promises.unlink(tempFilePath);
    }
    console.error('Error uploading image to OpenAI:', error);
    throw error;
  }
}

async function handleIncomingMessage(message) {
  const contactId = message.from;
  let threadId = contactThreads[contactId];

  if (!threadId) {
    try {
      const initialMessage = {
        role: "user",
        content: [],
      };

      if (message.body) {
        initialMessage.content.push({ type: 'text', text: message.body });
      }

      if (message.hasMedia) {
        const media = await message.downloadMedia();
        const fileId = await uploadImageToOpenAI(media);
        initialMessage.content.push({ type: 'image_file', image_file: { file_id: fileId } });
      }

      const thread = await openai.beta.threads.create({
        messages: [initialMessage],
      });
      if (thread && thread.id) {
        threadId = thread.id;
        contactThreads[contactId] = threadId;
        saveThreads(contactThreads);
      } else {
        console.error('Failed to create thread:', thread);
        return;
      }
    } catch (error) {
      console.error('Error creating thread:', error);
      return;
    }
  } else {
    try {
      const messageContent = {
        role: 'user',
        content: [],
      };

      if (message.body) {
        messageContent.content.push({ type: 'text', text: message.body });
      }

      if (message.hasMedia) {
        const media = await message.downloadMedia();
        const fileId = await uploadImageToOpenAI(media);
        messageContent.content.push({ type: 'image_file', image_file: { file_id: fileId } });
      }

      await openai.beta.threads.messages.create(
        threadId,
        messageContent
      );
    } catch (error) {
      console.error('Error appending message to thread:', error);
      return;
    }
  }

  try {
    const run = await openai.beta.threads.runs.create(
      threadId,
      { assistant_id: ASSISTANT_ID, max_completion_tokens: 50  }
    );

    const response = await pollForResponse(threadId, run.id);
    if (response) {
      console.log(`Responding to ${contactId}: ${response}`);
      await client.sendMessage(contactId, response);
    }
  } catch (error) {
    console.error('Error running thread or polling for response:', error);
  }
}

async function pollForResponse(threadId, runId) {
  try {
    const success = await wait_for_run_completion(threadId, runId, 30, 1);
    if (success) {
      const messagesResponse = await openai.beta.threads.messages.list(threadId);
      const assistantResponse = find_latest_assistant_response(messagesResponse);
      if (assistantResponse) {
        console.log("Assistant's response:", assistantResponse);
        return assistantResponse;
      } else {
        console.error("No response from assistant found.");
        return null;
      }
    } else {
      console.log("Polling attempts exceeded without completion.");
      return null;
    }
  } catch (error) {
    console.error('Error polling for response:', error);
    return null;
  }
}

async function wait_for_run_completion(threadId, runId, timeout = 30, interval = 1) {
  let startTime = Date.now();
  let max_completion_tokens = 50;

  while (true) {
    const elapsedTime = (Date.now() - startTime) / 1000;
    if (elapsedTime > timeout) {
      console.log("Polling attempts exceeded without completion. Elapsed time:", elapsedTime, "seconds");
      return false;
    }

    try {
      const runStatus = await openai.beta.threads.runs.retrieve(threadId, runId);
      console.log(`Run status: ${runStatus.status} at ${elapsedTime} seconds`);

      if (runStatus.status === "completed") {
        return true;
      } else if (runStatus.status === "incomplete") {
        console.log('Incomplete run status:', runStatus);
        // Increment tokens by 50 and create a new run with the increased token limit
        max_completion_tokens += 50;
        const newRun = await openai.beta.threads.runs.create(threadId, {
          assistant_id: ASSISTANT_ID,
          max_completion_tokens: max_completion_tokens
        });
        runId = newRun.id; // Update runId for the new run
        startTime = Date.now(); // Reset start time for the new run attempt
      }
      else if (runStatus.status === "failed" || runStatus.status === "canceled") {
        console.log(`Run failed or was canceled.`);
        return false;
      }
    } catch (error) {
      console.error('Error retrieving run status:', error);
      return false;
    }

    await new Promise(resolve => setTimeout(resolve, interval * 1000));
  }
}

function find_latest_assistant_response(messagesResponse) {
  const assistantMessages = messagesResponse.data.filter(message => message.role === 'assistant');
  if (assistantMessages.length > 0) {
    const latestMessage = assistantMessages[0];
    if (latestMessage.content && latestMessage.content.length > 0) {
      return latestMessage.content.map(item => item.text.value).join('\n');
    }
  }
  return null;
}

client.initialize();
