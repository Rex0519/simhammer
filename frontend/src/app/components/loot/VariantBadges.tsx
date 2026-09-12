import { useLanguage } from '../../lib/i18n';

/** Void Forged / Catalyst pills shown next to a drop's item name. Accepts any
 *  item carrying the variant markers (Drop Finder `DropItem` or roster `ReportItem`). */
export default function VariantBadges({
  item,
}: {
  item: {
    is_void_forge?: boolean;
    is_catalyst?: boolean;
    owned?: boolean;
    from_tier_token?: boolean;
  };
}) {
  const { t } = useLanguage();
  return (
    <>
      {item.is_void_forge && (
        <span className="rounded bg-purple-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-purple-300">
          {t('loot.voidforged')}
        </span>
      )}
      {item.owned && (
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-on-surface-variant">
          {t('loot.alreadyOwned')}
        </span>
      )}
      {item.is_catalyst && (
        <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-sky-300">
          {t('loot.catalyst')}
        </span>
      )}
      {item.from_tier_token && (
        <span
          title={t('loot.tierTokenReason')}
          className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-300"
        >
          {t('loot.tierToken')}
        </span>
      )}
    </>
  );
}
