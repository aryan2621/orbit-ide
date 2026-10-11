// Kotlin, Java and XML code intelligence for Android projects (kotlin-lsp, jdtls, LemMinX).
// Each server starts only when a file of its language opens inside a Gradle project.
import { invoke } from "@tauri-apps/api/core";
import { registerLanguageServer, ServerCommand } from "./languageServer";
import { useUi } from "../state/ui";

const resolver = (language: string) => (root: string) =>
  invoke<ServerCommand | null>("android_language_server", { root, language });

const kotlin = registerLanguageServer({ language: "kotlin", resolve: resolver("kotlin"), triggerCharacters: [".", ":", "@"] });
const java = registerLanguageServer({ language: "java", resolve: resolver("java"), triggerCharacters: [".", "@"] });
const xml = registerLanguageServer({ language: "xml", resolve: resolver("xml"), triggerCharacters: ["<", ":", '"', " "] });

/** Restarts all Android language servers, e.g. after installing one from the setup wizard. */
export async function restartAndroidServers() {
  await Promise.all([kotlin.restart(), java.restart(), xml.restart()]);
}

// Closing the Setup wizard may mean a server was just installed: try again on the next file open.
useUi.subscribe((s, prev) => {
  if (prev.showSetup && !s.showSetup) [kotlin, java, xml].forEach((server) => server.retryUnavailable());
});
