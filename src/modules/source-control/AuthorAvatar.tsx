import { usePreferencesStore } from "@/modules/settings/preferences";
import { memo, useEffect, useState } from "react";
import { authorInitials, authorTint } from "./lib/authorAvatar";
import { peekAuthorAvatar, resolveAuthorAvatar } from "./lib/avatarCache";

export const AuthorAvatar = memo(function AuthorAvatar({
  name,
  email,
  size = 14,
}: {
  name: string;
  email: string;
  size?: number;
}) {
  const enabled = usePreferencesStore((s) => s.sourceControlAvatars);
  // Seeding from the cache keeps an already known avatar on the first paint,
  // so scrolling a long commit list does not re-render every row.
  const [src, setSrc] = useState<string | null>(() =>
    enabled ? (peekAuthorAvatar(email) ?? null) : null,
  );

  useEffect(() => {
    if (!enabled) {
      setSrc(null);
      return;
    }
    const cached = peekAuthorAvatar(email);
    if (cached !== undefined) {
      setSrc(cached);
      return;
    }
    let cancelled = false;
    void resolveAuthorAvatar(email).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, email]);

  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="shrink-0 rounded-[3px] object-cover"
        onError={() => setSrc(null)}
      />
    );
  }

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[3px] font-mono text-[8.5px] font-bold uppercase tabular-nums text-background"
      style={{
        width: size,
        height: size,
        backgroundColor: authorTint(email || name),
      }}
    >
      {authorInitials(name)}
    </span>
  );
});
