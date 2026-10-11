import { useEffect, useState } from "react";
import { AppPermission, AppSettingsInfo, appSettingsApi } from "../lib/ipc";
import { useProject } from "../state/project";
import { promptText } from "../components/Prompt";
import { IconClose } from "../components/Icons";

/** Info.plist usage strings: key → (label, a starting description). */
const IOS_PERMISSIONS: [string, string, string][] = [
  ["NSCameraUsageDescription", "Camera", "This app uses the camera to take photos and videos."],
  ["NSPhotoLibraryUsageDescription", "Photo Library", "This app needs access to your photos so you can choose images."],
  ["NSPhotoLibraryAddUsageDescription", "Save to Photos", "This app saves photos and videos to your library."],
  ["NSMicrophoneUsageDescription", "Microphone", "This app uses the microphone to record audio."],
  ["NSLocationWhenInUseUsageDescription", "Location (While Using)", "This app uses your location to show nearby results."],
  ["NSLocationAlwaysAndWhenInUseUsageDescription", "Location (Always)", "This app uses your location in the background to keep you updated."],
  ["NSContactsUsageDescription", "Contacts", "This app accesses your contacts so you can share with friends."],
  ["NSCalendarsFullAccessUsageDescription", "Calendars", "This app adds and reads events in your calendar."],
  ["NSRemindersFullAccessUsageDescription", "Reminders", "This app creates reminders for you."],
  ["NSBluetoothAlwaysUsageDescription", "Bluetooth", "This app uses Bluetooth to connect to nearby devices."],
  ["NSFaceIDUsageDescription", "Face ID", "This app uses Face ID to sign you in securely."],
  ["NSMotionUsageDescription", "Motion & Fitness", "This app uses motion data to track your activity."],
  ["NSSpeechRecognitionUsageDescription", "Speech Recognition", "This app converts your speech to text."],
  ["NSHealthShareUsageDescription", "Health (Read)", "This app reads health data to show your progress."],
  ["NSHealthUpdateUsageDescription", "Health (Write)", "This app saves workouts to Health."],
  ["NSUserTrackingUsageDescription", "Tracking", "Your data will be used to deliver personalized ads."],
  ["NSLocalNetworkUsageDescription", "Local Network", "This app finds and connects to devices on your network."],
];

/** Common Android permissions (runtime ones prompt the user). */
const ANDROID_PERMISSIONS: [string, string][] = [
  ["android.permission.INTERNET", "Internet"],
  ["android.permission.ACCESS_NETWORK_STATE", "Network state"],
  ["android.permission.CAMERA", "Camera"],
  ["android.permission.RECORD_AUDIO", "Microphone"],
  ["android.permission.ACCESS_FINE_LOCATION", "Precise location"],
  ["android.permission.ACCESS_COARSE_LOCATION", "Approximate location"],
  ["android.permission.ACCESS_BACKGROUND_LOCATION", "Background location"],
  ["android.permission.POST_NOTIFICATIONS", "Notifications"],
  ["android.permission.READ_MEDIA_IMAGES", "Photos"],
  ["android.permission.READ_MEDIA_VIDEO", "Videos"],
  ["android.permission.READ_MEDIA_AUDIO", "Audio files"],
  ["android.permission.READ_CONTACTS", "Read contacts"],
  ["android.permission.WRITE_CONTACTS", "Write contacts"],
  ["android.permission.READ_CALENDAR", "Read calendar"],
  ["android.permission.WRITE_CALENDAR", "Write calendar"],
  ["android.permission.BLUETOOTH_CONNECT", "Bluetooth connect"],
  ["android.permission.BLUETOOTH_SCAN", "Bluetooth scan"],
  ["android.permission.USE_BIOMETRIC", "Biometrics"],
  ["android.permission.VIBRATE", "Vibrate"],
  ["android.permission.WAKE_LOCK", "Keep awake"],
  ["android.permission.FOREGROUND_SERVICE", "Foreground service"],
  ["android.permission.RECEIVE_BOOT_COMPLETED", "Start at boot"],
  ["android.permission.ACTIVITY_RECOGNITION", "Physical activity"],
];

const label = (key: string) => IOS_PERMISSIONS.find((p) => p[0] === key)?.[1] ?? ANDROID_PERMISSIONS.find((p) => p[0] === key)?.[1];

/** The app's display name and permissions (Info.plist / AndroidManifest.xml). */
export default function AppSettings({ root, onClose }: { root: string; onClose: () => void }) {
  const { scheme, configuration } = useProject();
  const [info, setInfo] = useState<AppSettingsInfo | null>(null);
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<AppPermission[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setInfo(null);
    appSettingsApi.get(root, scheme ?? "", configuration).then((i) => {
      setInfo(i);
      setName(i.displayName ?? "");
      setPermissions(i.permissions);
    });
  }, [root, scheme, configuration]);

  const android = info?.platform === "android";
  const editable = info && !info.error;
  const relative = (f: string) => (f.startsWith(root + "/") ? f.slice(root.length + 1) : f);
  const changed = () => setSaved(false);
  const missingText = !android && permissions.some((p) => !p.value.trim());

  const add = async (key: string) => {
    if (key === "custom") {
      const custom = await promptText(android ? "Permission name" : "Info.plist key", {
        placeholder: android ? "android.permission.NFC" : "NSAppleMusicUsageDescription",
        detail: android ? undefined : "Usage description keys start with NS and end with UsageDescription.",
      });
      if (!custom?.trim()) return;
      key = custom.trim();
    }
    if (!key || permissions.some((p) => p.key === key)) return;
    const preset = IOS_PERMISSIONS.find((p) => p[0] === key)?.[2] ?? "";
    setPermissions([...permissions, { key, value: android ? "" : preset }]);
    changed();
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await appSettingsApi.save(root, scheme ?? "", configuration, name, permissions);
      setSaved(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const presets: [string, string][] = android ? ANDROID_PERMISSIONS : IOS_PERMISSIONS.map(([k, l]) => [k, l]);
  const available = presets.filter(([k]) => !permissions.some((p) => p.key === k));

  return (
    <div className="overlay" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="setup settings">
        <header className="setup-header">
          <div>
            <h1>App Settings</h1>
            <p className="muted">
              {info?.files.length ? `Saved to ${info.files.map(relative).join(" and ")}.` : "The name on the Home Screen and the permissions the app asks for."}
            </p>
          </div>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        {info === null ? (
          <div className="setup-step skeleton" />
        ) : (
          <>
            <section className="settings-section">
              <label className="field">
                <span>Display name {android ? "(android:label)" : "(CFBundleDisplayName)"}</span>
                <input className="text-input" value={name} disabled={!editable} onChange={(e) => (setName(e.target.value), changed())} />
              </label>
            </section>

            <section className="settings-section">
              <h2>Permissions</h2>
              {!permissions.length && <p className="muted">{android ? "No permissions declared." : "No usage descriptions. iOS requires one for each protected resource the app uses."}</p>}
              {permissions.map((p, i) => (
                <div key={p.key} className="perm-row">
                  <div className="perm-head">
                    <span>{label(p.key) ?? p.key}</span>
                    {label(p.key) && <small className="muted">{p.key}</small>}
                    <span className="grow" />
                    <button className="icon-btn" title="Remove" disabled={!editable} onClick={() => (setPermissions(permissions.filter((_, j) => j !== i)), changed())}>
                      <IconClose />
                    </button>
                  </div>
                  {!android && (
                    <input
                      className="text-input"
                      placeholder="Why the app needs this (shown to users)"
                      value={p.value}
                      disabled={!editable}
                      onChange={(e) => (setPermissions(permissions.map((q, j) => (j === i ? { ...q, value: e.target.value } : q))), changed())}
                    />
                  )}
                </div>
              ))}
              <select className="perm-add" value="" disabled={!editable} onChange={(e) => add(e.target.value)}>
                <option value="">Add permission…</option>
                {available.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
                <option value="custom">Other…</option>
              </select>
              {saved && <p className="muted">Saved.{android ? "" : " Rebuild the app to see the changes."}</p>}
            </section>
          </>
        )}

        {(error || info?.error) && <div className="check-error">{error || info?.error}</div>}

        <footer className="setup-footer">
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" disabled={!editable || busy || missingText} title={missingText ? "Every permission needs a description" : undefined} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
