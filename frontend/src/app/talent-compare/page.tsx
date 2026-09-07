'use client';

import { useCallback, useMemo } from 'react';
import ErrorAlert from '../components/ui/ErrorAlert';
import SimcDownloadBanner from '../components/ui/SimcDownloadBanner';
import { useSimContext } from '../components/sim-config/SimContext';
import { useSimSubmit } from '../lib/useSimSubmit';
import TalentPicker from '../components/talents/TalentPicker';
import ConfigFooter from '../components/sim-config/ConfigPanel';
import { specDisplayName } from '../lib/types';
import { useLanguage } from '../lib/i18n';
import { parseCharacterInfo } from '../lib/character';
import { useComputeChoice } from '../lib/useComputeChoice';

export default function TalentComparePage() {
  const { simcInput, hasInput, talentBuilds } = useSimContext();
  const { t } = useLanguage();
  const [compute, setCompute] = useComputeChoice('talent_compare');

  const characterInfo = useMemo(() => parseCharacterInfo(simcInput), [simcInput]);
  const enoughBuilds = talentBuilds.length >= 2;

  const buildPayload = useCallback(
    () => ({
      simc_input: simcInput,
      talent_builds: talentBuilds.map((b) => ({ name: b.name, talent_string: b.talentString })),
      compute_provider: compute,
    }),
    [simcInput, talentBuilds, compute]
  );

  const validate = useCallback(() => {
    if (!hasInput) return t('validation.simcTooShort');
    if (!enoughBuilds) return t('talentCompare.needTwo');
    return null;
  }, [hasInput, enoughBuilds, t]);

  const { submit, submitting, error, buttonLabel } = useSimSubmit({
    endpoint: '/api/talent-compare/sim',
    buildPayload,
    validate,
  });

  const submitLabel = enoughBuilds
    ? buttonLabel(t('talentCompare.run', { count: talentBuilds.length }))
    : t('talentCompare.needTwo');

  return (
    <div className="space-y-6 pb-20">
      <div>
        <h1 className="mb-2 font-headline text-4xl font-black uppercase tracking-tighter text-on-surface">
          {t('page.talentCompareTitle')}
        </h1>
        <p className="max-w-2xl text-sm text-on-surface-variant">{t('page.talentCompareDesc')}</p>
      </div>

      {characterInfo && (
        <div className="flex items-center gap-3 rounded-xl border border-outline-variant/10 bg-surface-container-low px-6 py-4">
          <h2 className="font-headline text-2xl font-extrabold tracking-tight text-on-surface">
            {characterInfo.name}
          </h2>
          <span className="rounded bg-primary-container/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-primary">
            {specDisplayName(characterInfo.spec)} {characterInfo.className.replace(/_/g, ' ')}
          </span>
          {characterInfo.realm && (
            <span className="border-l border-outline-variant/30 pl-3 text-sm text-on-surface-variant">
              {characterInfo.realm}
            </span>
          )}
        </div>
      )}

      <TalentPicker defaultView="view" defaultCompare />

      <SimcDownloadBanner />
      <ErrorAlert message={error} />
      <ConfigFooter
        onSubmit={submit}
        submitting={submitting}
        buttonLabel={submitLabel}
        disabled={!hasInput || !enoughBuilds}
        compute={compute}
        onComputeChange={setCompute}
      />
    </div>
  );
}
