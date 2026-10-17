import { describe, expect, it } from 'vitest';
import { groupVideos, playAllStart, videoDate, videoName, type VideoItem } from './videos';

const item = (id: number, dir: string, name: string, completed = false): VideoItem => ({
  id,
  path: `${dir}/${name}`,
  parent_dir: dir,
  file_name: name,
  modified_at: 0,
  position_secs: 0,
  duration_secs: null,
  completed,
  frame: null,
});

describe('videos', () => {
  it('names a file without its extension or separators', () => {
    expect(videoName('Summer_party.2024.mp4')).toBe('Summer party 2024');
    expect(videoName('clip.mkv')).toBe('clip');
  });

  it('dates a video from its name, else from the file', () => {
    expect(videoDate('VID_20240601_120000.mp4', 0)?.getFullYear()).toBe(2024);
    expect(videoDate('2023-12-24 Christmas.mov', 0)?.getMonth()).toBe(11);
    expect(videoDate('clip 2.mp4', 1_700_000_000)?.getTime()).toBe(1_700_000_000_000);
    expect(videoDate('clip.mp4', 0)).toBeNull();
    // A number that is not a date is not taken for one.
    expect(videoDate('take 20241399.mp4', 0)).toBeNull();
  });

  it('groups by folder, the root first, each in file-manager order', () => {
    const groups = groupVideos(
      [
        item(1, 'C:\\v\\Trip', 'clip 10.mp4'),
        item(2, 'C:\\v', 'loose.mp4'),
        item(3, 'C:\\v\\Trip', 'clip 2.mp4'),
        item(4, 'C:\\v\\A party', 'x.mp4'),
      ],
      'C:\\v\\'
    );
    expect(groups.map((g) => g.name)).toEqual(['', 'A party', 'Trip']);
    expect(groups[2].items.map((v) => v.id)).toEqual([3, 1]);
  });

  it('starts Play all at the first unfinished video', () => {
    const [group] = groupVideos([item(1, '/v', 'a.mp4', true), item(2, '/v', 'b.mp4')], '/v');
    expect(playAllStart(group)?.id).toBe(2);
    const [done] = groupVideos([item(1, '/v', 'a.mp4', true)], '/v');
    expect(playAllStart(done)?.id).toBe(1);
  });
});
