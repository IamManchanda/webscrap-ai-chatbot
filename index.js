import dotenv from "dotenv";
import axios from "axios";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import { ChromaClient } from "chromadb";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const chromaClient = new ChromaClient({
  path: "http://localhost:8000",
});
chromaClient.heartbeat();

const WEB_COLLECTION = "WEB_SCRAPED_DATA_COLLECTION-1";

const ingestedUrls = new Set();

// No need to scrape the below URLs as then too much API calls will be made
// and they are not useful for a side project like this
const skipUrlPatterns = [
  /^https:\/\/www\.harrymanchanda\.com\/portfolio\/web-development\/.+/,
];

function shouldSkipUrl(url) {
  return skipUrlPatterns.some((pattern) => pattern.test(url));
}

async function scrapeWebPage(url = "") {
  try {
    const { data } = await axios.get(url, {});
    const $ = cheerio.load(data);

    const pageHead = $("head").html(),
      pageBody = $("body").html();

    const uniqExternalLinks = new Set(),
      uniqInternalLinks = new Set();

    $("a").each((_, el) => {
      const link = $(el).attr("href");
      if (!link) return;
      if (link === "/") return; // skip homepage link
      if (link.startsWith("#")) return; // skip anchors
      if (link.startsWith("mailto:")) return; // skip mailto links
      if (link.startsWith("tel:")) return; // skip tel links

      if (link.startsWith("http")) {
        uniqExternalLinks.add(link);
      } else {
        uniqInternalLinks.add(link);
      }
    });

    return {
      head: pageHead,
      body: pageBody,
      externalLinks: [...uniqExternalLinks],
      internalLinks: [...uniqInternalLinks],
    };
  } catch (error) {
    console.log(`Error scraping ${url}:`, error);
  }
}

async function generateVectorEmbeddings({ text }) {
  const embedding = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
    encoding_format: "float",
  });
  return embedding.data[0].embedding;
}

async function insertIntoDb({ embedding, url, body = "", head = "" }) {
  const collection = await chromaClient.getOrCreateCollection({
    name: WEB_COLLECTION,
  });
  collection.add({
    ids: [url],
    embeddings: [embedding],
    metadatas: [{ url, body, head }],
  });
}

async function ingest(baseUrl = "") {
  if (ingestedUrls.has(baseUrl)) {
    console.log(`Already ingested ${baseUrl}`);
    return;
  }

  if (shouldSkipUrl(baseUrl)) {
    console.log(`⚠️ Skipped URL: ${baseUrl}`);
    return;
  }

  ingestedUrls.add(baseUrl);

  console.log(`👷 Ingesting ${baseUrl}`);

  const { head, body, internalLinks } = await scrapeWebPage(baseUrl);

  const headChunks = chunkText(head, 40);
  const bodyChunks = chunkText(body, 40);

  for (const chunk of headChunks) {
    const embedding = await generateVectorEmbeddings({ text: chunk });
    await insertIntoDb({ embedding, url: baseUrl, head: chunk });
  }

  for (const chunk of bodyChunks) {
    const embedding = await generateVectorEmbeddings({ text: chunk });
    await insertIntoDb({ embedding, url: baseUrl, body: chunk });
  }

  for (const link of internalLinks) {
    const absoluteUrl = new URL(link, baseUrl).href;
    await ingest(absoluteUrl);
  }

  console.log(`🚀 Ingesting Success ${baseUrl}!`);
}

// Execute below line only when you want to ingest data
// ingest("https://www.harrymanchanda.com/");

async function chat(query = "") {
  const queryEmbedding = await generateVectorEmbeddings({ text: query });
  const collection = await chromaClient.getOrCreateCollection({
    name: WEB_COLLECTION,
  });
  const collectionResult = await collection.query({
    nResults: 10,
    queryEmbeddings: [queryEmbedding],
  });
  const urls = collectionResult.metadatas[0]
    .map((e) => e.url)
    .filter((e) => e.trim() !== "" && !!e);

  console.log({
    urls,
  });
}

chat("Who is Harry Manchanda?");

function chunkText(text, chunkSize) {
  if (!text || chunkSize <= 0) return [];

  const words = text.split(/\s+/), // Split by whitespace
    n = words.length,
    chunks = [];

  for (let i = 0; i <= n - 1; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(" "));
  }

  return chunks;
}
