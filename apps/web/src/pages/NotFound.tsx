import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <p className="font-mono text-[13px] text-ink-muted">404</p>
      <h1 className="mt-1 font-display text-[26px] font-semibold text-ink">
        That page does not exist
      </h1>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">
        The link may be out of date, or the screen may not be built yet.
      </p>
      <Link
        to="/"
        className="mt-5 inline-block rounded-lg bg-brand px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-brand-deep"
      >
        Back to home
      </Link>
    </div>
  );
}
