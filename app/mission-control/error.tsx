"use client";

export default function MissionControlError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="mc-placeholder" aria-label="Mission Control error">
      <p className="mc-placeholder-label">Error boundary</p>
      <h2>Shell route failed to render</h2>
      <p>The reference shell remains available. Route content is not delivered yet.</p>
      <button type="button" className="mc-retry-button" onClick={reset}>
        Retry
      </button>
    </section>
  );
}
