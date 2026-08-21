export type MissionControlRoute = {
  readonly label: string;
  readonly href: string;
  readonly segment: string;
  readonly description: string;
};

export const missionControlRoutes = [
  {
    label: "Overview",
    href: "/mission-control",
    segment: "",
    description: "Reference shell landing surface.",
  },
  {
    label: "Agents",
    href: "/mission-control/agents",
    segment: "agents",
    description: "Agent operations placeholder.",
  },
  {
    label: "Office",
    href: "/mission-control/office",
    segment: "office",
    description: "Office operations placeholder.",
  },
  {
    label: "Tasks",
    href: "/mission-control/tasks",
    segment: "tasks",
    description: "Task orchestration placeholder.",
  },
  {
    label: "Chat",
    href: "/mission-control/chat",
    segment: "chat",
    description: "Mission chat placeholder.",
  },
  {
    label: "Content",
    href: "/mission-control/content",
    segment: "content",
    description: "Content operations placeholder.",
  },
  {
    label: "Schedule",
    href: "/mission-control/schedule",
    segment: "schedule",
    description: "Schedule operations placeholder.",
  },
  {
    label: "Documentation",
    href: "/mission-control/documentation",
    segment: "documentation",
    description: "Documentation placeholder.",
  },
] as const satisfies readonly MissionControlRoute[];

export type MissionControlSegment = (typeof missionControlRoutes)[number]["segment"];

export const missionControlShellTokens = {
  desktopRailWidth: "264px",
  mobileBreakpoint: "1024px",
  activeAccent: "#22d3ee",
  canvas: "#03111f",
} as const;

export function getMissionControlRoute(segment: string | null | undefined) {
  return missionControlRoutes.find((route) => route.segment === (segment ?? ""));
}
