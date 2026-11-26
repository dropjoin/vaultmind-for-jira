import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Heading,
  Inline,
  Lozenge,
  ProgressBar,
  SectionMessage,
  Stack,
  Text,
} from '@forge/react';
import { invoke } from '@forge/bridge';

/**
 * Issue panel (dossier feature 5): verdict badge, the caps, a daily
 * spend gauge, the policy summary, and this issue's audit trail.
 * All data comes from the resolver (getPanelData) — the panel renders
 * the deterministic engine's stored verdict, nothing is computed here.
 */
const App = () => {
  const [data, setData] = useState(null);

  useEffect(() => {
    invoke('getPanelData').then(setData).catch(() => setData({ error: true }));
  }, []);

  if (!data) return <Text>Loading VaultMind verdict…</Text>;
  if (data.error) {
    return (
      <SectionMessage title="VaultMind unavailable" appearance="error">
        <Text>The policy check could not be loaded. Try reloading the issue.</Text>
      </SectionMessage>
    );
  }
  if (!data.policy.configured) {
    return (
      <SectionMessage title="No VaultMind policy configured" appearance="warning">
        <Text>
          A Jira admin must set the spending caps and vendor allowlist on the
          VaultMind Policy admin page before requests can pass.
        </Text>
      </SectionMessage>
    );
  }

  const v = data.verdict;
  const gauge = data.policy.dailyCapCents > 0
    ? Math.min(data.spentTodayCents / data.policy.dailyCapCents, 1)
    : 0;

  return (
    <Stack space="space.200">
      <Inline alignBlock="center" space="space.100">
        <Heading size="medium">VaultMind</Heading>
        {v && (
          <Lozenge appearance={v.verdict === 'PASS' ? 'success' : 'removed'}>
            {v.verdict}
          </Lozenge>
        )}
        {data.policy.frozen && <Lozenge appearance="moved">FROZEN</Lozenge>}
      </Inline>

      {v ? (
        <Box>
          <Text>
            {v.vendor || '(no vendor)'} — checked at {v.evaluatedAt}
          </Text>
          {v.reasons.map((reason, i) => (
            <Text key={i}>{reason}</Text>
          ))}
          {v.primaryRule && <Text>Rule fired: {v.primaryRule}</Text>}
        </Box>
      ) : (
        <Text>No evaluation yet for this issue.</Text>
      )}

      <Box>
        <Heading size="small">Policy</Heading>
        <Text>Per-transaction cap: {data.policy.perTxCap}</Text>
        <Text>Daily cap: {data.policy.dailyCap}</Text>
        <Text>Spent today: {data.spentToday} of {data.policy.dailyCap}</Text>
        <ProgressBar value={gauge} />
        <Text>
          Allowed vendors: {data.policy.allowedVendors.join(', ') || '(none)'}
        </Text>
      </Box>

      {data.auditTrail.length > 0 && (
        <Box>
          <Heading size="small">Audit trail (this issue)</Heading>
          {data.auditTrail.map((entry, i) => (
            <Text key={i}>
              {entry.evaluatedAt} — {entry.verdict}
              {entry.primaryRule ? ` (${entry.primaryRule})` : ''} via {entry.source}
            </Text>
          ))}
        </Box>
      )}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
