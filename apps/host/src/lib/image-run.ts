import type { ImageLora, ImageSettings } from './types';

/**
 * The steps and guidance an image uses. The LoRAs that are on set them (this chat's values for a LoRA, else its own): with
 * several, the most steps and the lowest guidance. What no LoRA sets comes from this chat's settings for new images or edits.
 */
export function imageRun(settings: ImageSettings, loras: ImageLora[], edit: boolean): { steps: number; cfg: number; from: string[] } {
  const on = settings.loras.flatMap(c => { const l = loras.find(k => k.file === c.file); return l ? [{ title: l.title, steps: c.steps === undefined ? l.steps : c.steps, cfg: c.cfg === undefined ? l.cfg : c.cfg }] : []; });
  const steps = on.flatMap(l => (l.steps ? [l.steps] : [])), cfgs = on.flatMap(l => (l.cfg ? [l.cfg] : []));
  return {
    steps: steps.length ? Math.max(...steps) : edit ? settings.editSteps : settings.steps,
    cfg: cfgs.length ? Math.min(...cfgs) : edit ? settings.editCfg : settings.cfg,
    from: on.filter(l => l.steps || l.cfg).map(l => l.title),
  };
}
