import React from 'react';
import { X } from 'lucide-react';

interface HudSettingsPanelProps {
  scale: number;
  gap: number;
  connected: boolean;
  onScaleChange: (value: number) => void;
  onGapChange: (value: number) => void;
  onCancel: () => void;
  onSave: () => void;
}

export const HudSettingsPanel: React.FC<HudSettingsPanelProps> = ({
  scale, gap, connected, onScaleChange, onGapChange, onCancel, onSave,
}) => (
  <section
    className="stats-panel hud-settings-panel"
    aria-labelledby="hud-settings-title"
    data-pet-interactive="true"
  >
    <header className="stats-header">
      <h2 id="hud-settings-title" className="stats-title">头顶文字设置</h2>
      <button type="button" className="stats-icon-btn" aria-label="关闭" onClick={onCancel}>
        <X size={14} />
      </button>
    </header>
    <div className="hud-settings-controls">
      <label>
        <span>文字大小 <span>{Math.round(scale * 100)}%</span></span>
        <input className="scale-slider" type="range" min={60} max={150} step={1}
          value={Math.round(scale * 100)} onChange={(event) => onScaleChange(event.target.valueAsNumber / 100)} />
      </label>
      <label>
        <span>头顶间距 <span>{gap} px</span></span>
        <input className="scale-slider" type="range" min={0} max={64} step={1}
          value={gap} onChange={(event) => onGapChange(event.target.valueAsNumber)} />
      </label>
      <div className="hud-settings-actions">
        <button type="button" className="btn-deny" onClick={onCancel}>取消</button>
        <button type="button" className="btn-approve" disabled={!connected} onClick={onSave}>保存</button>
      </div>
    </div>
  </section>
);
