'use strict';

/**
 * Thin Jira REST wrapper over @forge/api (app-system-user calls).
 * @forge/api is required lazily so this module loads under plain Node
 * (unit tests, local linting) where the Forge runtime is absent.
 */

function forgeApi() {
  try {
    return require('@forge/api');
  } catch (err) {
    throw new Error('@forge/api is not available outside the Forge runtime.');
  }
}

/** Fetch an issue with the fields the policy engine needs. */
async function getIssue(issueKey) {
  const { api, route } = forgeApi();
  const res = await api.asApp().requestJira(
    route`/rest/api/3/issue/${issueKey}`,
    { headers: { Accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`Jira issue fetch failed for ${issueKey}: HTTP ${res.status}`);
  return res.json();
}

/** Build a minimal ADF document from plain-text paragraphs + bullets. */
function textToAdf(paragraphs, bullets) {
  const content = [];
  for (const text of paragraphs || []) {
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text }],
    });
  }
  if (bullets && bullets.length) {
    content.push({
      type: 'bulletList',
      content: bullets.map((text) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      })),
    });
  }
  return { type: 'doc', version: 1, content };
}

/** Post a comment on an issue (used for the verdict comment). */
async function addComment(issueKey, adfBody) {
  const { api, route } = forgeApi();
  const res = await api.asApp().requestJira(
    route`/rest/api/3/issue/${issueKey}/comment`,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: adfBody }),
    },
  );
  if (!res.ok) throw new Error(`Jira comment failed for ${issueKey}: HTTP ${res.status}`);
  return res.json();
}

module.exports = { getIssue, addComment, textToAdf };
