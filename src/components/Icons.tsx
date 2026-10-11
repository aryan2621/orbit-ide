import type { ReactNode, SVGProps } from "react";

function Svg({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconClose = () => (
  <Svg width="12" height="12">
    <path d="M18 6L6 18M6 6l12 12" />
  </Svg>
);
export const IconChevronRight = () => (
  <Svg width="12" height="12">
    <path d="M9 18l6-6-6-6" />
  </Svg>
);
export const IconChevronDown = () => (
  <Svg width="12" height="12">
    <path d="M6 9l6 6 6-6" />
  </Svg>
);
export const IconFolder = () => (
  <Svg width="14" height="14">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);
export const IconFolderOpen = () => (
  <Svg>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1" />
    <path d="M3 7v10a2 2 0 0 0 2 2h12l4-8H7l-4 8" />
  </Svg>
);
export const IconFile = () => (
  <Svg width="14" height="14">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Svg>
);
export const IconTerminal = () => (
  <Svg width="14" height="14">
    <path d="M4 17l6-5-6-5M12 19h8" />
  </Svg>
);
export const IconSidebar = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </Svg>
);
export const IconPanelBottom = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 15h18" />
  </Svg>
);
export const IconSun = () => (
  <Svg>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);
export const IconMoon = () => (
  <Svg>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </Svg>
);
export const IconMonitor = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </Svg>
);
export const IconHammer = () => (
  <Svg>
    <path d="M15 12l-8.5 8.5a2.1 2.1 0 0 1-3-3L12 9" />
    <path d="M17.6 15L22 10.6M20.9 11.7l-6.7-6.7a2 2 0 0 0-1.4-.6H10l2.5 2.5v2.1l2.6 2.6h2.1l2.6 2.6" />
  </Svg>
);
export const IconStopSquare = () => (
  <Svg>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Svg>
);
export const IconPlus = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconError = () => (
  <Svg width="14" height="14">
    <circle cx="12" cy="12" r="9" />
    <path d="M15 9l-6 6M9 9l6 6" />
  </Svg>
);
export const IconWarning = () => (
  <Svg width="14" height="14">
    <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4M12 17h.01" />
  </Svg>
);
export const IconCopy = () => (
  <Svg width="14" height="14">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </Svg>
);
export const IconCheck = () => (
  <Svg width="14" height="14">
    <path d="M20 6L9 17l-5-5" />
  </Svg>
);
export const IconPlay = () => (
  <Svg>
    <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" fill="currentColor" />
  </Svg>
);
export const IconKey = () => (
  <Svg>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="M10.7 12.3L21 2M16 7l3 3M19 4l2 2" />
  </Svg>
);
export const IconPhone = () => (
  <Svg>
    <rect x="6" y="2" width="12" height="20" rx="2.5" />
    <path d="M11 18h2" />
  </Svg>
);
export const IconBug = () => (
  <Svg>
    <rect x="8" y="6" width="8" height="14" rx="4" />
    <path d="M12 10v10M3 13h5M16 13h5M4 7l4 2M20 7l-4 2M4 19l4-2M20 19l-4-2M9.5 6.5L8 4M14.5 6.5L16 4" />
  </Svg>
);
export const IconProblems = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v6M12 16.5v.5" />
  </Svg>
);
export const IconOutput = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9h10M7 13h10M7 17h6" />
  </Svg>
);
export const IconFlask = () => (
  <Svg>
    <path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7.5 15h9" />
  </Svg>
);
export const IconContinue = () => (
  <Svg>
    <path d="M5 5v14" />
    <path d="M9 5.5v13a.5.5 0 0 0 .8.4l9-6.5a.5.5 0 0 0 0-.8l-9-6.5a.5.5 0 0 0-.8.4z" fill="currentColor" />
  </Svg>
);
export const IconPause = () => (
  <Svg>
    <path d="M8 5v14M16 5v14" />
  </Svg>
);
export const IconStepOver = () => (
  <Svg>
    <path d="M4 14a8 8 0 0 1 15-3.5M19 5v5.5h-5.5" />
    <circle cx="12" cy="19" r="1.5" fill="currentColor" />
  </Svg>
);
export const IconStepInto = () => (
  <Svg>
    <path d="M12 3v10M7.5 8.5L12 13l4.5-4.5" />
    <circle cx="12" cy="19" r="1.5" fill="currentColor" />
  </Svg>
);
export const IconStepOut = () => (
  <Svg>
    <path d="M12 14V4M7.5 8.5L12 4l4.5 4.5" />
    <circle cx="12" cy="19" r="1.5" fill="currentColor" />
  </Svg>
);
export const IconArchive = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
  </Svg>
);
export const IconFilePlus = () => (
  <Svg width="15" height="15">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M12 11v6M9 14h6" />
  </Svg>
);
export const IconFolderPlus = () => (
  <Svg width="15" height="15">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M12 10v6M9 13h6" />
  </Svg>
);
export const IconRefresh = () => (
  <Svg width="15" height="15">
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
    <path d="M21 3v5h-5" />
  </Svg>
);
export const IconSearch = () => (
  <Svg>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </Svg>
);
export const IconGitBranch = () => (
  <Svg>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="7" r="2" />
    <path d="M6 7v10M18 9a6 6 0 0 1-6 6H6" />
  </Svg>
);
export const IconPackage = () => (
  <Svg>
    <path d="M21 8l-9-5-9 5v8l9 5 9-5z" />
    <path d="M3 8l9 5 9-5M12 13v8" />
  </Svg>
);
export const IconFiles = () => (
  <Svg>
    <path d="M15 3H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z" />
    <path d="M15 3v4h4M6 7H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-1" />
  </Svg>
);
export const IconSettings = () => (
  <Svg>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
);
export const IconCommand = () => (
  <Svg>
    <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />
  </Svg>
);
export const IconArrowUp = () => (
  <Svg width="14" height="14">
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Svg>
);
export const IconArrowDown = () => (
  <Svg width="14" height="14">
    <path d="M12 5v14M19 12l-7 7-7-7" />
  </Svg>
);
export const IconMinus = () => (
  <Svg width="14" height="14">
    <path d="M5 12h14" />
  </Svg>
);
export const IconUndo = () => (
  <Svg width="14" height="14">
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);
export const IconMore = () => (
  <Svg width="14" height="14">
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </Svg>
);
export const IconCode = () => (
  <Svg>
    <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />
  </Svg>
);
export const IconSparkle = () => (
  <Svg>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" />
  </Svg>
);
export const IconInfo = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 7.5v.5" />
  </Svg>
);
export const IconKeyboard = () => (
  <Svg>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
  </Svg>
);
export const IconPalette = () => (
  <Svg>
    <path d="M12 3a9 9 0 1 0 0 18c1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4.2-4-7.6-9-7.6z" />
    <circle cx="7.5" cy="11" r="1" />
    <circle cx="10" cy="7" r="1" />
    <circle cx="14.5" cy="7" r="1" />
  </Svg>
);
