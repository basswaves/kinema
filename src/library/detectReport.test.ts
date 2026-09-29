import { describe, expect, it } from 'vitest';
import type { AutoStep } from './api';
import { detectLines, NOTHING_NEW } from './detectReport';

const step = (root_path: string, step: string, ran: boolean, note: string): AutoStep => ({
  root_path,
  step,
  ran,
  note,
});

describe('detectLines', () => {
  it('says nothing when nothing was expected to run', () => {
    expect(detectLines([])).toEqual([]);
  });

  it('folds "nothing new" in every folder into one line', () => {
    const steps = ['D:\\TV', 'E:\\More TV', '\\\\nas\\Shows'].map((p) =>
      step(p, 'current', false, 'no new episodes since Skiptro last ran')
    );
    expect(detectLines(steps)).toEqual([NOTHING_NEW]);
  });

  it('still reports a problem, naming the folder when there are several', () => {
    const steps = [
      step('D:\\TV', 'current', false, 'no new episodes since Skiptro last ran'),
      step('E:\\More TV', 'skiptro', false, 'Skiptro failed: no output'),
      step('\\\\nas\\Shows', 'root', false, 'folder not reachable, so nothing was detected'),
    ];
    expect(detectLines(steps)).toEqual([
      'Intro and credits detection in More TV: Skiptro failed: no output.',
      'Intro and credits detection in Shows: folder not reachable, so nothing was detected.',
    ]);
  });

  it('leaves the folder out when there is only one', () => {
    expect(detectLines([step('D:\\TV', 'analyse', true, 'analysed 4 episodes')])).toEqual([
      'Intro and credits detection: analysed 4 episodes.',
    ]);
  });

  it('names the folder even when only one of several has news', () => {
    const steps = [
      step('D:\\TV', 'current', false, 'no new episodes since Skiptro last ran'),
      step('E:\\More TV', 'analyse', true, 'analysed 6 episodes'),
    ];
    expect(detectLines(steps)).toEqual([
      'Intro and credits detection in More TV: analysed 6 episodes.',
    ]);
  });

  it('says the same thing once', () => {
    const note = 'Skiptro did not run: it is not at C:\\Tools\\skiptro.exe any more';
    const steps = [step('D:\\TV', 'skiptro', false, note), step('D:\\TV', 'skiptro', false, note)];
    expect(detectLines(steps)).toHaveLength(1);
  });
});
