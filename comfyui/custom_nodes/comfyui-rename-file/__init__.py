"""RenameFile: move a finished file to its final name, inside a ComfyUI graph.

The world builders train a splat into a workspace folder and then need it at
the path its database row names. Doing that in the graph, as its last node,
means the move happens on the machine that has the file - which is not the
machine running Flowise when ComfyUI is on another box.

The pack this replaces was never published, so this is written to the
interface the flows use:
  inputs   source_path, dest_path (strings; source_path is usually wired from
           the node that saved the file)
  output   the path the file ended up at
  history  a line of text; on failure it starts "RENAME FAILED", which
           38-HY-World checks for rather than the graph erroring, so a splat
           that trained but could not be moved is reported as exactly that.
"""
import os
import shutil


class RenameFile:
    CATEGORY = 'utils'
    FUNCTION = 'rename'
    OUTPUT_NODE = True
    RETURN_TYPES = ('STRING',)
    RETURN_NAMES = ('path',)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            'required': {
                'source_path': ('STRING', {'default': ''}),
                'dest_path': ('STRING', {'default': ''}),
            }
        }

    @classmethod
    def IS_CHANGED(cls, source_path, dest_path):
        # A move has an effect outside the graph, so it is never served from
        # ComfyUI's cache: the same inputs twice means move twice.
        return float('nan')

    def rename(self, source_path, dest_path):
        source = os.path.normpath(str(source_path).strip())
        dest = os.path.normpath(str(dest_path).strip())
        try:
            if not str(source_path).strip() or not str(dest_path).strip():
                raise ValueError('source_path and dest_path are both required')
            if not os.path.exists(source):
                raise FileNotFoundError(f'no such file: {source}')
            if os.path.abspath(source) != os.path.abspath(dest):
                os.makedirs(os.path.dirname(dest) or '.', exist_ok=True)
                # shutil.move rather than os.replace: it also works across
                # drives, where a rename cannot.
                if os.path.exists(dest):
                    os.remove(dest)
                shutil.move(source, dest)
            message = f'renamed {source} -> {dest}'
            result = dest
        except Exception as e:  # reported, not raised - see the module docstring
            message = f'RENAME FAILED: {source} -> {dest}: {e}'
            result = source
        print(f'[RenameFile] {message}')
        return {'ui': {'text': [message]}, 'result': (result,)}


NODE_CLASS_MAPPINGS = {'RenameFile': RenameFile}
NODE_DISPLAY_NAME_MAPPINGS = {'RenameFile': 'Rename File'}
