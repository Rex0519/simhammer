'use client';

import { useLanguage } from '../../lib/i18n';
import Select from './Select';

interface UpgradeOption {
  key: number;
  label: string;
  sublabel?: string;
}

interface UpgradeSelectProps {
  value: number;
  onChange: (value: number) => void;
  options: UpgradeOption[];
}

export default function UpgradeSelect({ value, onChange, options }: UpgradeSelectProps) {
  const { t } = useLanguage();
  return (
    <Select
      value={value}
      onChange={onChange}
      options={options.map((o) => ({
        value: o.key,
        label: o.label,
        sublabel: o.sublabel ? t('loot.ilvl', { ilvl: o.sublabel }) : undefined,
      }))}
    />
  );
}
