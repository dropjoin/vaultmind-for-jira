import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Code,
  Form,
  Heading,
  Label,
  RequiredAsterisk,
  SectionMessage,
  Stack,
  Text,
  TextArea,
  Textfield,
  Toggle,
} from '@forge/react';
import { invoke } from '@forge/bridge';

/**
 * Admin page (dossier features 1 + 8): policy configuration (caps,
 * currency, allowlists, frozen toggle, designated project) stored
 * per-install, plus the audit report with CSV export.
 */
const App = () => {
  const [form, setForm] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [audit, setAudit] = useState(null);
  const [csv, setCsv] = useState('');

  useEffect(() => {
    invoke('getPolicy').then((p) => setForm({
      perTxCap: String(p.perTxCap ?? ''),
      dailyCap: String(p.dailyCap ?? ''),
      currency: p.currency || 'USD',
      allowedVendors: (p.allowedVendors || []).join('\n'),
      allowedRequesters: (p.allowedRequesters || []).join('\n'),
      frozen: !!p.frozen,
      projectKey: p.projectKey || '',
    })).catch(() => setLoadError(true));
    invoke('getAuditLog', {}).then(setAudit).catch(() => setAudit({ entries: [] }));
  }, []);

  if (loadError) {
    return (
      <SectionMessage title="VaultMind policy could not be loaded" appearance="error">
        <Text>Try reloading the page. If the problem persists, ask an admin to check the app.</Text>
      </SectionMessage>
    );
  }
  if (!form) return <Text>Loading VaultMind policy…</Text>;

  const set = (key) => (e) =>
    setForm({ ...form, [key]: e.target ? e.target.value : e });

  const onSubmit = async () => {
    setError('');
    setSaved(false);
    try {
      await invoke('savePolicy', form);
      setSaved(true);
    } catch (err) {
      setError(err && err.message
        ? err.message
        : 'The policy could not be saved. Check the caps and try again.');
    }
  };

  const onExport = async () => {
    setError('');
    try {
      const { csv: text } = await invoke('exportAuditCsv', {});
      setCsv(text);
    } catch (err) {
      setCsv('');
      setError('The audit export could not be generated. Try again.');
    }
  };

  return (
    <Stack space="space.300">
      <Heading size="large">VaultMind Policy</Heading>
      <Text>
        Requests in the designated project are checked against these rules
        by a deterministic engine. Changes apply to the next evaluation.
      </Text>
      {saved && (
        <SectionMessage title="Policy saved" appearance="success">
          <Text>The new policy is active for all VaultMind checks.</Text>
        </SectionMessage>
      )}
      {error && (
        <SectionMessage title="VaultMind error" appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      )}

      <Form onSubmit={onSubmit}>
        <Stack space="space.200">
          <Box>
            <Label labelFor="perTxCap">
              Per-transaction cap <RequiredAsterisk />
            </Label>
            <Textfield id="perTxCap" name="perTxCap" type="number"
              value={form.perTxCap} onChange={set('perTxCap')} />
          </Box>
          <Box>
            <Label labelFor="dailyCap">
              Daily cap <RequiredAsterisk />
            </Label>
            <Textfield id="dailyCap" name="dailyCap" type="number"
              value={form.dailyCap} onChange={set('dailyCap')} />
          </Box>
          <Box>
            <Label labelFor="currency">Currency</Label>
            <Textfield id="currency" name="currency"
              value={form.currency} onChange={set('currency')} />
          </Box>
          <Box>
            <Label labelFor="projectKey">Designated project key (blank = all projects)</Label>
            <Textfield id="projectKey" name="projectKey"
              value={form.projectKey} onChange={set('projectKey')} />
          </Box>
          <Box>
            <Label labelFor="allowedVendors">Allowed vendors (one per line)</Label>
            <TextArea id="allowedVendors" name="allowedVendors"
              value={form.allowedVendors} onChange={set('allowedVendors')} />
          </Box>
          <Box>
            <Label labelFor="allowedRequesters">
              Allowed requesters (one per line, blank = any requester)
            </Label>
            <TextArea id="allowedRequesters" name="allowedRequesters"
              value={form.allowedRequesters} onChange={set('allowedRequesters')} />
          </Box>
          <Box>
            <Label labelFor="frozen">Freeze all spending</Label>
            <Toggle id="frozen" name="frozen"
              isChecked={form.frozen} onChange={() => set('frozen')(!form.frozen)} />
          </Box>
          <Button type="submit" appearance="primary">Save policy</Button>
        </Stack>
      </Form>

      <Heading size="medium">Audit report (today)</Heading>
      {audit && audit.entries.length === 0 && <Text>No evaluations recorded today.</Text>}
      {audit && audit.entries.map((entry, i) => (
        <Text key={i}>
          {entry.evaluatedAt} — {entry.issueKey} — {entry.verdict}
          {entry.primaryRule ? ` (${entry.primaryRule})` : ''} — via {entry.source}
        </Text>
      ))}
      <Button onClick={onExport}>Export today's audit log as CSV</Button>
      {csv && <Code>{csv}</Code>}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
