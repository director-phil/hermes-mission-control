import { notFound } from "next/navigation";
import { getMissionControlRoute } from "../navigation";

export default async function MissionControlSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const route = getMissionControlRoute(section);

  if (!route || route.segment === "") {
    notFound();
  }

  return (
    <section className="mc-placeholder" aria-label={`${route.label} placeholder`}>
      <p className="mc-placeholder-label">{route.label}</p>
      <h2>not delivered yet</h2>
      <p>{route.description}</p>
    </section>
  );
}
