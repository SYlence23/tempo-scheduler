import ast
import io
import pathlib
import tokenize

root = pathlib.Path(__file__).resolve().parent.parent
ignored = {'node_modules', 'tools', '.runtime', '.git', '__pycache__'}
count = 0
for path in root.rglob('*.py'):
    if any(part in ignored for part in path.relative_to(root).parts):
        continue
    source = path.read_text(encoding='utf-8-sig')
    ast.parse(source, filename=str(path))
    if any(token.type == tokenize.COMMENT for token in tokenize.generate_tokens(io.StringIO(source).readline)):
        raise ValueError(f'Source comment: {path}')
    count += 1
print(f'Verified {count} Python files: valid syntax, no source comments.')
