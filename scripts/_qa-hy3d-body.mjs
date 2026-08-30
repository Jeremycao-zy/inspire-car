/**
 * 回归测试：混元 3D 提交体构造。
 * 重点验证 Bug：图生模式不能同时发送 Prompt + ImageBase64，
 * 否则云端返回 "Prompt和ImageBase64、ImageUrl不能同时存在"。
 *
 * 运行：node scripts/_qa-hy3d-body.mjs
 * 结果：通过打印 PASS，失败抛 Error。
 */
import { buildJobBody } from '../server/hunyuan3d.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const dummyB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

// 1. 有图时：必须带 ImageBase64，且不能带 Prompt
const withImg = buildJobBody({ imagesBase64: [dummyB64], prompt: 'a wheel', faceCount: 225000 });
assert(withImg.ImageBase64 === dummyB64, '有图时应设置 ImageBase64');
assert(!('Prompt' in withImg), '有图时不能设置 Prompt');
assert(withImg.FaceCount === 225000, 'FaceCount 应透传');

// 2. 无图时：走文生，必须带 Prompt，且不能带 ImageBase64
const textOnly = buildJobBody({ imagesBase64: [], prompt: 'a wheel', faceCount: 150000 });
assert(textOnly.Prompt === 'a wheel', '无图时应设置 Prompt');
assert(!('ImageBase64' in textOnly), '无图时不能设置 ImageBase64');

// 3. 多视图 JSON 在有图时也能附带（不视为 ImageUrl 冲突）
const multi = buildJobBody({
  imagesBase64: [dummyB64],
  multiViewJson: JSON.stringify([{ Angle: 'left', Url: 'https://example.com/l.jpg' }]),
});
assert(Array.isArray(multi.MultiViewImages), '多视图 JSON 应解析为数组');
assert(multi.MultiViewImages.length === 1, '多视图数组长度应为 1');

// 4. 空参数默认安全
const empty = buildJobBody({});
assert(!('Prompt' in empty) && !('ImageBase64' in empty), '空参数不产生 Prompt/ImageBase64');

console.log('✅ _qa-hy3d-body PASS：图生/文生互斥，Prompt 与 ImageBase64 不再同时出现');
