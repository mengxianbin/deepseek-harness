/**
 * The web-search settings page: the provider switch — a plain switch between
 * Messages search and the Search and Fetch APIs, or a segmented control that
 * adds Brave Search when the Host serves its section — the selected section's
 * endpoint and per-search limit, and the key, which
 * is written through the credentials domain, never into the settings section,
 * so the literal never rides a response.
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SegmentedControl, SettingsForm, SettingsSecretField, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels, type WebSearchSettingsLocaleKey } from './locales.ts'
import styles from './WebSearchCard.module.css'
import type { ProviderTarget, WebSearchCardFace, WebSearchCardState } from './web-search-card-controller.ts'

/** Props the renderer binds for the web-search page. */
export type WebSearchCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.webSearch'>
  & InjectFace<WebSearchCardFace>

/** The switch row: the segmented control with a Brave position, or the plain API switch. */
function ProviderSwitch(props: {
  t: (key: WebSearchSettingsLocaleKey) => string
  state: WebSearchCardState
  disabled: boolean
  onToggle: (enabled: boolean) => void
  onSelect: (target: ProviderTarget) => void
}) {
  const { t, state, disabled } = props
  if (!state.braveAvailable) {
    if (!state.apiSwitchAvailable) return null
    return (
      <div className={styles.feature}>
        <label className={styles.toggleRow}>
          <span>{t('useSearchApi')}</span>
          <Switch checked={state.useSearchApi} label={t('useSearchApi')} disabled={disabled || state.apiSwitchBlocked}
            onChange={(checked) => { props.onToggle(checked) }} />
        </label>
        <p className={styles.hint}>
          {t('useSearchApiHint')}
          <a className={styles.link} href={t('searchGuideUrl')} target="_blank" rel="noopener noreferrer">{t('searchGuide')}</a>
        </p>
      </div>
    )
  }
  const mode: ProviderTarget = state.useSearchApi ? 'api' : state.useBrave ? 'brave' : 'messages'
  return (
    <div className={styles.feature}>
      <SegmentedControl
        id="web-search-provider"
        label={t('providerSelect')}
        value={mode}
        disabled={disabled || state.apiSwitchBlocked}
        options={[
          { value: 'messages', label: t('providerMessages') },
          ...state.apiSwitchAvailable ? [{ value: 'api' as const, label: t('providerApi') }] : [],
          { value: 'brave', label: t('providerBrave') },
        ]}
        onChange={(next) => { props.onSelect(next) }}
      />
    </div>
  )
}

/**
 * Render the web-search provider's one-liner or its settings form, as the Plugins page asks.
 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
 * @returns the one-liner, or the form.
 */
export function WebSearchCard(props: WebSearchCardProps) {
  const { t } = props
  const state = props.useWebSearchCard(snapshot => snapshot)
  if (props.view === 'summary') return t('description')
  const disabled = !state.writable || state.saving
  const brave = !state.useSearchApi && state.useBrave
  const searchApi = state.useSearchApi
  const limitField = brave || searchApi ? 'count' : 'maxUses'
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <ProviderSwitch t={t} state={state} disabled={disabled}
        onToggle={props.setSearchApi} onSelect={props.setProvider} />
      <SettingsSecretField
        id="plugin-config-web-search-key"
        label={t('apiKey')}
        hint={t('apiKeyHint')}
        // The credentials domain accepts a key even when the settings document
        // itself is read-only; they are separate stores with separate refusals.
        // Its own writability is what disables this control — a key sourced
        // from the process environment cannot be written from here.
        disabled={!state.apiKeyWritable}
        text={state.apiKey.text}
        configured={state.apiKeyConfigured}
        stateLabel={state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset')}
        onEdit={(text) => { props.edit('apiKey', text) }}
      />
      <SettingsValueField
        id="plugin-config-web-search-endpoint"
        label={t(brave ? 'braveBaseUrl' : searchApi ? 'searchApiBaseUrl' : 'baseUrl')}
        hint={t(brave ? 'braveBaseUrlHint' : searchApi ? 'searchApiBaseUrlHint' : 'baseUrlHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.baseURL}
        onEdit={(text) => { props.edit('baseURL', text) }}
        onReset={() => { props.resetField('baseURL') }}
      />
      <SettingsValueField
        id={limitField === 'count' ? 'plugin-config-web-search-count' : 'plugin-config-web-search-max-uses'}
        label={t(limitField)}
        hint={t(limitField === 'count' ? (brave ? 'braveCountHint' : 'countHint') : 'maxUsesHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t(limitField === 'count' ? (brave ? 'invalidBraveCount' : 'invalidCount') : 'invalidNumber')}
        numeric
        disabled={disabled}
        {...state[limitField]}
        onEdit={(text) => { props.edit(limitField, text) }}
        onReset={() => { props.resetField(limitField) }}
      />
    </SettingsForm>
  )
}
