import { Joyride, STATUS, type EventData, type Step } from 'react-joyride'

const steps: Step[] = [
  { target: 'body', placement: 'center', content: 'Build your first pipeline by adding an input file, choosing a tool, connecting them, and running validation.' },
  { target: '[data-tour="tool-palette"]', content: 'Drag an Input File and a PLINK or bcftools tool from here onto the canvas.' },
  { target: '[data-tour="canvas"]', content: 'Connect output handles to input handles. Axis-split file groups automatically scatter downstream work.' },
  { target: '[data-tour="inspector"]', content: 'Configure parameters, resources, merge behavior, and file paths in the inspector.' },
  { target: '[data-tour="run-toolbar"]', content: 'Validate, preview scripts, then run when the connection and inputs are ready.' },
]

export function GuidedTour({ run, onDone }: { run: boolean; onDone: () => void }) {
  return (
    <Joyride
      steps={steps}
      run={run}
      continuous
      options={{
        backgroundColor: 'var(--color-bg-secondary)',
        buttons: ['back', 'skip', 'primary'],
        closeButtonAction: 'skip',
        primaryColor: 'var(--color-accent)',
        textColor: 'var(--color-text-primary)',
        zIndex: 1000,
      }}
      onEvent={(state: EventData) => {
        if (state.status === STATUS.FINISHED || state.status === STATUS.SKIPPED) onDone()
      }}
    />
  )
}
