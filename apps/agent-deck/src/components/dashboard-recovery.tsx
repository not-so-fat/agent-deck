import { useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import {
  attemptTrustedLauncherOpen,
  copyDashboardOpenCommand,
  DASHBOARD_OPEN_COMMAND,
} from '@/lib/dashboard-recovery';
import { useToast } from '@/hooks/use-toast';

export const DECK_DEALER_LINE = 'Agent Deck carries the method; Agent Dealer runs the issue queue.';

/**
 * NOT-286: calm recovery for the bare loopback origin. Rendered when the
 * browser holds no dashboard session — plain English, one recovery action,
 * and no authority minted from this page.
 */
export default function DashboardRecovery() {
  const [manualOpen, setManualOpen] = useState(false);
  const { toast } = useToast();

  const handleOpenDashboard = () => {
    // Trusted local launcher where one is installed; the command fallback is
    // revealed immediately either way (see below).
    attemptTrustedLauncherOpen();
    setManualOpen(true);
  };

  const handleCopy = () => {
    void copyDashboardOpenCommand().then((copied) => {
      toast(
        copied
          ? { title: 'Command copied', description: 'Run it in your terminal.' }
          : {
              title: 'Copy failed',
              description: `Type this in your terminal: ${DASHBOARD_OPEN_COMMAND}`,
            },
      );
    });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      <div className="text-center max-w-lg px-4" data-testid="dashboard-recovery">
        <h2 className="text-2xl font-bold text-gray-100 mb-4">Open your dashboard securely</h2>
        <p className="text-gray-300 mb-2">
          This page is Agent Deck running on your own machine — nothing is broken.
        </p>
        <p className="text-gray-400 text-sm mb-6">
          Your browser just doesn&apos;t have a launch pass yet. Agent Deck opens the
          dashboard with a fresh pass each time, so typing this address alone can
          never sign anyone in — this page can&apos;t grant access by itself.
        </p>
        <button
          type="button"
          onClick={handleOpenDashboard}
          data-testid="button-open-dashboard"
          className="px-5 py-2.5 bg-blue-600 text-white rounded hover:bg-blue-700 font-medium"
        >
          <span className="inline-flex items-center gap-2">
            <ExternalLink className="w-4 h-4" />
            Open dashboard
          </span>
        </button>
        {manualOpen && (
          <div className="mt-6 rounded-lg border border-white/10 bg-black/30 p-4" data-testid="dashboard-recovery-manual">
            <p className="text-gray-300 text-sm mb-1">
              If nothing opened, run this in your terminal:
            </p>
            <code className="mb-3 block rounded bg-black/40 px-3 py-2 text-gray-100 select-all">
              {DASHBOARD_OPEN_COMMAND}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              data-testid="button-copy-open-command"
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
            >
              <span className="inline-flex items-center gap-2">
                <Copy className="w-4 h-4" />
                Copy command
              </span>
            </button>
            <p className="text-gray-500 text-xs mt-3">
              Then come back here and reload — or pick <strong>Open dashboard</strong> from
              the Agent Deck menubar, which runs the same command.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
