// Copyright 2024 BeehiveInnovations / Omniforge Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server tools/apilookup.py — LOOKUP_PROMPT constant
// © BeehiveInnovations — see ../NOTICE.md.

/**
 * Web-lookup instructions injected into the structured response.
 * Verbatim copy of LOOKUP_PROMPT from apilookup.py (strip()ed).
 */
export const LOOKUP_PROMPT = `\
MANDATORY: You MUST perform this research in a SEPARATE SUB-TASK using your web search tool.

CRITICAL RULES - READ CAREFULLY:
- Launch your environment's dedicated web search capability (for example \`websearch\`, \`web_search\`, or another native
web-search tool such as the one you use to perform a web search online) to gather sources - do NOT call this \`apilookup\` tool again
during the same lookup, this is ONLY an orchestration tool to guide you and has NO web search capability of its own.
- ALWAYS run the search from a separate sub-task/sub-process so the research happens outside this tool invocation.
- If the environment does not expose a web search tool, immediately report that limitation instead of invoking \`apilookup\` again.

MISSION:
Research the latest, most authoritative documentation for the requested API, SDK, library, framework, programming language feature, or tool to answer the user's question accurately using a SUB-AGENT in a separate process.

SEARCH STRATEGY (MAXIMUM 2-4 SEARCHES TOTAL FOR THIS MISSION - THEN STOP):
- IMPORTANT: Begin by determining today's date and current year
- MANDATORY FOR OS-TIED APIS/SDKs: If the request involves iOS, macOS, Windows, Linux, Android, watchOS, tvOS, or any OS-specific framework/API:
  * FIRST perform a web search to determine "what is the latest [OS name] version [current year]"
  * If the search is around a specific tool or an IDE, confirm the latest version "latest version [tool name]"
  * DO NOT rely on your training data or knowledge cutoff for OS versions - you MUST search for current information
  * ONLY AFTER confirming the current OS version, search for APIs/SDKs/frameworks for that specific version
  * Example workflow: Search "latest iOS version [current year]" → Find current version → Then search "[current iOS version] SwiftUI glass effect button [current year]"
- MANDATORY FOR MAJOR FRAMEWORKS/LANGUAGES: For rapidly-evolving ecosystems, verify current stable version:
  * Languages: Node.js, Python, Ruby, Rust, Go, Java, .NET/C#, PHP, Kotlin, Swift
  * Web frameworks: React, Vue, Angular, Next.js, Nuxt, Svelte, SvelteKit, Remix, Astro, SolidJS
  * Backend frameworks: Django, Flask, FastAPI, Rails, Laravel, Spring Boot, Express, NestJS, Axum
  * Mobile: Flutter, React Native, Jetpack Compose, SwiftUI
  * Build tools: Vite, Webpack, esbuild, Turbopack, Rollup
  * Package managers: npm, pnpm, yarn, pip, cargo, go modules, maven, gradle
  * Search pattern: "latest [framework/language/SDK] version [current year]" BEFORE searching for specific APIs
  * ONLY consider articles, documentation, and resources dated within the current year or most recent release cycle
  * Ignore or deprioritize results from previous years unless they are still the current official documentation
- ALWAYS find current official documentation, release notes, changelogs, migration guides, and authoritative blog posts. Newest APIs / SDKs released or updated in the current year trump older ones.
- Prioritize official sources: project documentation sites, GitHub repositories, package registries (npm, PyPI, crates.io, Maven Central, NuGet, RubyGems, Packagist, etc.), and official blogs
- Check version-specific documentation when relevant and add current year to ensure latest docs are retrieved (e.g., "React docs [current year]", "Python what's new [current year]", "TypeScript breaking changes [current year]", "Next.js app router [current year]")
- Look for recent Stack Overflow discussions, GitHub issues, RFC documents, or official discussion forums when official docs are incomplete
- Cross-reference multiple sources to validate syntax, method signatures, configuration options, and best practices
- Search for deprecation warnings, security advisories, or migration paths between major versions
- STOP IMMEDIATELY after 2-4 searches maximum - DO NOT continue exploring tangential topics, examples, tutorials, or supplementary material
- If latest, more current, authoritative information has been found: STOP looking further
- ALWAYS cite authoritative sources with links (official docs, changelogs, GitHub releases, package registry pages)`;
