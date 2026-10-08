# Faster repository context for Pair Code

This proposal follows the October 7 session on a private monorepo. Native search, batched reads, bounded session research briefs, and quiet slider updates are implemented in 0.1.3. Local hybrid indexing is implemented in 0.2.0; see the README for its current scope and limitations. Saved lexical deltas, durable 30-minute quiet / 60-minute age embedding queues and reusable local source-backed briefs are now implemented. Exploration separates routing from synthesis within one isolated researcher. Parallel research workers and automatic complete dependency graphs remain proposed. The design discussion below records the original proposal.

## What the trace shows

| Question                  | Backend duration | Provider calls | Search time |
| ------------------------- | ---------------: | -------------: | ----------: |
| Explore prefilter         |           13.8 s |              9 |       5.4 s |
| Improvements to prefilter |           39.5 s |             37 |       9.0 s |
| Explain copilot MCP       |           30.9 s |             28 |         0 s |
| Who consumes copilot MCP? |           94.2 s |             45 |      48.6 s |

Trace: `2026-10-07T10-36-18-467Z-23c04c94.jsonl`, Pair Code 0.1.2. The last question caused 41 explorer calls, including 17 directory maps and ten searches. Local search opened up to 100 editor documents per page and rechecked ignores through Git for each file. Sequential model requests accounted for another 37.5 seconds. There were no provider output-limit finishes driving this delay.

The 0.1.3 native search measurements on that actual workspace were 194 ms for the first 40 `copilot-mcp` matches across the repository, 652 ms for all seven eligible matches filtered to `src/`, 62 ms for `issue_approval_token` in `services/copilot`, and 69 ms for `nginx` in `services/prefilter`. These searches cover eligible text files rather than a 100-file page; they are not an end-to-end replay of the human conversation. Binary, ignored, oversized and unavailable files remain outside coverage.

A synthetic two-file Cerebras exploration took about 3.7 seconds and six model requests with batched reads and a source-search tool, compared with about 12.3 seconds and 16 requests in the prior trial. These are individual model runs with different available tools, not a controlled repeated benchmark or a guarantee for a monorepo.

## Why indexing belongs in the next step

Cursor describes incremental file hashing, syntactic chunks, background embeddings, and caching by chunk content. That gives retrieval a head start before a user asks a question. Its documentation does not disclose every component responsible for final-answer latency. [Cursor's published indexing design](https://cursor.com/blog/secure-codebase-indexing)

Pair Code should maintain a local hybrid index:

- Paths, symbols and lexical search for exact identifiers, imports, routes, configuration values and error strings.
- Vector search over code chunks for natural-language concepts and aliases, such as “pre-filter” versus `prefilter`, or “where do we validate approvals?”
- Language-service and parsed relationships to verify definitions, callers and dependencies. Similarity alone does not prove a caller or cross-service dependency.

Each chunk should carry a workspace identity, relative path, language, source hash, line range and chunk hash. Content hashes let us update only changed files/chunks. Index active services and open files first, then expand in the background. A first query can use native search while indexing is incomplete.

The index should stay local. Local versus hosted embeddings should be an explicit setting; adding semantic indexing should not silently upload an entire repository. Reuse the existing trust, sharing, ignore and realpath checks for ingestion and retrieval. Rebuild or invalidate affected records after ignore-policy changes, moves, deletes, branch changes or source-hash mismatches. Keep dirty editor buffers as a current overlay. Retrieve a small set of relevant chunks and re-read current source before proposing edits; cached line numbers and embeddings can be stale.

The query path should be: current editor/selection + brief research memory → hybrid retrieval → current source verification → answer or a focused exploration. The ordinary question should not require a planning model, multiple researchers and a reducer every time.

## Where parallel map/reduce helps

Use it for genuinely independent research areas, for example a requested service audit:

| Worker                  | Scope                                                         |
| ----------------------- | ------------------------------------------------------------- |
| Implementation          | Entrypoint, important functions, internal flow                |
| Consumers and contracts | Call sites, API/message contracts, shared configuration       |
| Tests and operations    | Test coverage, deployment configuration, reliability concerns |

A coordinator chooses two or three relevant workers. Each gets its own context, the focused question, a small set of retrieval hits and the permitted local tools. Workers remain read-only and return compact findings, file/line evidence and coverage. The parent combines those reports once, preserving disagreement and missing evidence. Parent cancellation and provider rate limits govern the whole run; a failing worker should not discard other verified findings.

For “what does this function do?”, retrieval plus one model should suffice. Parallel workers help broad audits and independent branches of an impact analysis. Dependent questions still need ordered investigation, and a reducer adds latency and inference cost. Broadcasting every question to every service would repeat the over-exploration problem.

## What to measure next

Use a fixed set of service explanations, caller questions, edits and audits across cold and warm indexes. Record first useful answer, total duration, provider rounds, tool time, retrieved bytes, evidence accuracy and missed callers. Compare native search + batching, hybrid retrieval, and parallel workers on the same questions. Treat any latency budget as a target until measured; avoid promising Cursor-like speed from an embedding feature alone.

## Slider behavior

OpenAI states that appended instructions can interrupt current speech. The slider's backend policy now updates locally, preserves in-flight research, and suppresses a late preview that violates the new setting. Voice instructions are coalesced and queued until measured playback/transcript activity is quiet. This is a playback heuristic rather than a guaranteed model turn boundary; a human session remains the appropriate check. [OpenAI delegation and update semantics](https://developers.openai.com/api/docs/guides/live-delegation)
