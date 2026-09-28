import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import DashboardRecovery, { DECK_DEALER_LINE } from '@/components/dashboard-recovery';

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fetch).mockClear();
});

function stubClipboard() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

describe('DashboardRecovery (NOT-286)', () => {
  it('explains the missing launch pass in plain English with a visible Open dashboard action', () => {
    render(<DashboardRecovery />);

    expect(screen.getByText('Open your dashboard securely')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open dashboard' })).toBeInTheDocument();
    // The manual command stays hidden until the action runs.
    expect(screen.queryByText('agent-deck open')).not.toBeInTheDocument();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('reveals the exact terminal command with an explicit instruction after the action', () => {
    render(<DashboardRecovery />);

    fireEvent.click(screen.getByRole('button', { name: 'Open dashboard' }));

    expect(screen.getByText('agent-deck open')).toBeInTheDocument();
    expect(screen.getByText(/run this in your terminal/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy command' }),
    ).toBeInTheDocument();
    // The handoff attempt mints nothing from the browser.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('copies the exact command when the copy action runs', async () => {
    const writeText = stubClipboard();
    render(<DashboardRecovery />);

    fireEvent.click(screen.getByRole('button', { name: 'Open dashboard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('agent-deck open');
    });
  });

  it('states the Deck/Dealer split in one line', () => {
    expect(DECK_DEALER_LINE).toBe(
      'Agent Deck carries the method; Agent Dealer runs the issue queue.',
    );
  });
});
