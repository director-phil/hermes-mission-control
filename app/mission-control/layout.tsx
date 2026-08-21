import MissionControlShell from "../components/MissionControlShell";

export default function MissionControlLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <MissionControlShell>{children}</MissionControlShell>;
}
