"""Patch ComfyUI_HYWorld2 so it runs with the utils3d MoGe needs.

HY-World 2 uses MoGe, and both use utils3d, but not the same one:
- MoGe (the commit HY-World pins) calls utils3d.torch.depth_to_points, which
  only the older utils3d API has (MoGe pins utils3d c5daf6f);
- HY-World's own utils3d_compat layer adapts to either API everywhere except
  intrinsics_from_fov, which always passes aspect_ratio - an argument only the
  newer API takes.
No single utils3d has both. So utils3d stays at MoGe's commit, and this changes
that one function to pass aspect_ratio only when utils3d accepts it, otherwise
giving the same ratio as the older API's width/height. The rest of the layer
already does exactly this.

    python patch-hyworld2.py <path to ComfyUI_HYWorld2>

Safe to run twice: it recognises its own patch.
"""
import pathlib
import sys

OLD = '''def intrinsics_from_fov(*, fov_x=None, fov_y=None, fov_max=None, fov_min=None, aspect_ratio=None):
    return _u3d_np.intrinsics_from_fov(
        fov_x=fov_x,
        fov_y=fov_y,
        fov_max=fov_max,
        fov_min=fov_min,
        aspect_ratio=aspect_ratio,
    )
'''

NEW = '''def intrinsics_from_fov(*, fov_x=None, fov_y=None, fov_max=None, fov_min=None, aspect_ratio=None):
    # AIMP patch (pc-worker/patch-hyworld2.py): aspect_ratio only exists in the
    # newer utils3d API. The older one, which MoGe needs, takes width/height.
    fn = _u3d_np.intrinsics_from_fov
    kwargs = dict(fov_x=fov_x, fov_y=fov_y, fov_max=fov_max, fov_min=fov_min)
    params = inspect.signature(fn).parameters
    if "aspect_ratio" in params:
        kwargs["aspect_ratio"] = aspect_ratio
    elif aspect_ratio is not None:
        kwargs["width"], kwargs["height"] = aspect_ratio, 1.0
    return fn(**kwargs)
'''

MARK = 'AIMP patch (pc-worker/patch-hyworld2.py)'


def main():
    pack = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
    done = 0
    for path in pack.rglob('utils3d_compat.py'):
        text = path.read_text(encoding='utf-8')
        if MARK in text:
            print(f'already patched: {path}')
            continue
        if OLD not in text:
            print(f'NOT PATCHED - the function has changed upstream, check it by hand: {path}')
            continue
        path.write_text(text.replace(OLD, NEW), encoding='utf-8')
        print(f'patched: {path}')
        done += 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
