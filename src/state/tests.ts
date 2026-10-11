// Starting test runs (all, current file, one class or test) on top of the project's job runner;
// results arrive on the build activity (`build.tests`).
import { create } from "zustand";
import { TestFilter } from "../lib/ipc";
import { useProject } from "./project";
import { fileText, useWorkspace } from "./workspace";

interface TestPrefs {
  /** Android: run on-device (androidTest) instead of JVM unit tests. */
  instrumented: boolean;
  setInstrumented: (instrumented: boolean) => void;
}

export const useTestPrefs = create<TestPrefs>((set) => ({
  instrumented: false,
  setInstrumented: (instrumented) => set({ instrumented }),
}));

const android = () => useProject.getState().info?.platform === "android";

export function runTests(only: TestFilter | null, instrumented = useTestPrefs.getState().instrumented) {
  return useProject.getState().startTests({ only, instrumented: android() && instrumented });
}

/** ⌘U. */
export const runAllTests = () => runTests(null);

/** The test class in the active file: from the last results when they cover it, else guessed from
 * the file (iOS: `Folder/FileName`, the folder being the test target; Android: `package.FileName`). */
export function runCurrentFile() {
  const path = useWorkspace.getState().activePath;
  if (!path) return;
  const known = useProject.getState().build.tests?.find((c) => c.file === path);
  if (known) return runTests({ suite: known.suiteId });
  const parts = path.split("/");
  const name = (parts.pop() ?? "").replace(/\.\w+$/, "");
  if (android()) {
    const pkg = /^\s*package\s+([\w.]+)/m.exec(fileText(path) ?? "")?.[1];
    return runTests({ suite: pkg ? `${pkg}.${name}` : name }, path.includes("/androidTest/"));
  }
  runTests({ suite: `${parts.pop()}/${name}` });
}
