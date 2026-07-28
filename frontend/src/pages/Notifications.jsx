import React, { useEffect, useState } from 'react';
import { getSettings, updateSetting } from '../api/client';
import { useToast } from '../components/ToastProvider.jsx';

export default function Notifications() {
  const showToast = useToast();
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings().then((s) => {
      setEnabled(s.telegram_notifications_enabled !== false);
      setLoading(false);
    });
  }, []);

  const handleToggle = async (checked) => {
    setEnabled(checked);
    setSaving(true);
    try {
      await updateSetting('telegram_notifications_enabled', checked);
      showToast(checked ? 'Telegram notifications enabled.' : 'Telegram notifications disabled.');
    } catch (err) {
      setEnabled(!checked);
      showToast(err.response?.data?.error || 'Failed to update setting — please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="card"><span className="hint">Loading…</span></div>;

  return (
    <div className="card">
      <h4>Telegram Notifications</h4>
      <p className="subtitle" style={{ marginTop: -4, marginBottom: 14 }}>
        When enabled, any scheduled or manual Flow run with a FAIL/ERROR/SCHEMA_DRIFT step sends an alert to the
        configured Telegram chat, and a follow-up message once it recovers to PASS. Turning this off stops all
        Telegram alerts without touching schedules themselves — they keep running and their results still land in
        the Dashboard as normal.
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => handleToggle(e.target.checked)}
        />
        Enable Telegram notifications
      </label>
    </div>
  );
}
