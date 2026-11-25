import {
  bearer,
  connection,
  error,
  matchesState,
  resourceCheck,
  segment,
  stateOption,
  target,
  text,
  verdict,
} from '@cairul/pdk';

export default function youtrack(options) {
  const api = connection(options, {
    prefix: 'YOUTRACK',
    tokenEnv: 'YOUTRACK_TOKEN',
    required: true,
    authModes: { bearer },
  });
  const issue = (shape, evaluate) =>
    resourceCheck({
      api,
      identifier: 'issue',
      parseURL: (url) => target(undefined, url, [api.host], /\/issue\/([^/]+)(?:\/|$)/),
      path: (id) => `api/issues/${segment(id)}`,
      query: { fields: 'resolved,customFields(name,value(name))' },
      shape,
      evaluate,
    });
  return {
    checkKinds: {
      'youtrack.issue-state': issue(
        { state: stateOption, field: text.default('State') },
        ({ customFields }, { state, field }) =>
          matchesState(customFields?.find(({ name }) => name === field)?.value?.name, state, 'Issue')
      ),
      'youtrack.issue-resolved': issue({}, (result) =>
        !Object.hasOwn(result, 'resolved')
          ? error('YouTrack returned no resolved field.')
          : verdict(result.resolved != null, 'Waiting for issue resolution.')
      ),
    },
  };
}
