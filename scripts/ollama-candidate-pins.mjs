/** Registry-provenance candidates only; independent review and economic G0 remain DENY. */
export const OLLAMA_CANDIDATE_PINS = Object.freeze({
  imageLinuxAmd64: '459985308d740b99071719baec2740a60f5b2b2d9b835c171991ae25690203da',
  modelName: 'qwen2.5-coder:0.5b',
  modelManifest: '4ff64a7f502a08b7616edb8ca0a79eb1853fc363d842b7df4b46915d11a3fb09',
  reviewStatus: 'PENDING',
  provenance: 'docs/checkpoints/ollama/LOOP2-REGISTRY-PROVENANCE-20261026T0636Z.json',
});
export function requireCandidatePinBinding({image, model}) {
  if (image !== OLLAMA_CANDIDATE_PINS.imageLinuxAmd64 ||
      model !== OLLAMA_CANDIDATE_PINS.modelManifest)
    throw new Error('OLLAMA_CANDIDATE_PIN_BINDING_MISMATCH');
  return true;
}
