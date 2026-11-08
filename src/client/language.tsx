/** The Settings → Language group: the default language for words a person reads. */
import { LIMITS } from '../limits.ts'
import { Input } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { ConfigHistory, Field, Fields, useBlockDraft, useSettings } from './settings-kit.tsx'
import { usePanel } from './provider.tsx'
import { Section } from './widgets.tsx'

/** One free-text value, saved with the block's revision; the next model request already uses the new language. */
export function LanguageSettings() {
  const { t } = usePanel()
  const { settings } = useSettings()
  const block = settings.blocks.language
  const draft = useBlockDraft('language', block.value, block.revision)
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <Section title={t('languageTitle')}>
          <p className="dt-hint">{t('languageIntro')}</p>
          <Field label={t('languageDefaultLabel')} hint={t('languageDefaultHint')}>
            <Input value={draft.value.default} maxLength={LIMITS.languageName}
              placeholder={t('languageDefaultPlaceholder')}
              onChange={event => draft.edit({ default: event.target.value })} />
          </Field>
          <p className="dt-hint">{t('languageExamples')}</p>
        </Section>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['language']} />
  </div>
}
