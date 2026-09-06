import ast
import contextlib
import sys
import sympy


def equation_output(source):
    tree = ast.parse(source, filename="<equation>")
    if not tree.body:
        raise ValueError("Enter an expression to calculate.")
    last = tree.body[-1]
    if isinstance(last, ast.Expr):
        tree.body[-1] = ast.copy_location(
            ast.Assign(targets=[ast.Name(id="_hilbert_result", ctx=ast.Store())], value=last.value), last
        )
    elif isinstance(last, (ast.Assign, ast.AnnAssign)) and last.value is not None:
        # Evaluate the RHS once, preserving assignments and their indentation.
        result = ast.copy_location(
            ast.Assign(targets=[ast.Name(id="_hilbert_result", ctx=ast.Store())], value=last.value), last
        )
        last.value = ast.Name(id="_hilbert_result", ctx=ast.Load())
        tree.body.insert(-1, result)
    else:
        raise ValueError("End with the expression or assignment whose result you want to insert.")
    namespace = {name: getattr(sympy, name) for name in sympy.__all__}
    namespace.update(zip("x y z t n k a b c".split(), sympy.symbols("x y z t n k a b c")))
    with contextlib.redirect_stdout(sys.stderr):
        exec(compile(ast.fix_missing_locations(tree), "<equation>", "exec"), namespace)
    result = namespace["_hilbert_result"]
    if result is None:
        raise ValueError("End with a symbolic expression instead of print().")
    return sympy.latex(result)
