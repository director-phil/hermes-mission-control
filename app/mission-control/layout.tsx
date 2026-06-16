import EnvironmentBanner from "../components/EnvironmentBanner";

export default function MissionControlLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-slate-950">
      <EnvironmentBanner />
      {children}
    </div>
  );
}
