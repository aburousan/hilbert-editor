import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import unittest

import sympy as sp

root = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hilbert_equation", root / "src-tauri/src/equation.py")
equation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(equation)


class SymbolicTests(unittest.TestCase):
    def test_derivative(self):
        x = sp.Symbol("x")
        self.assertEqual(equation.equation_output("diff(sin(x**2), x)"), sp.latex(2 * x * sp.cos(x**2)))

    def test_indentation_and_multiline_expression(self):
        source = "def square(value):\n    return value**2\n\nMatrix([\n    [square(x), 1],\n    [0, 2],\n])"
        self.assertEqual(equation.equation_output(source), sp.latex(sp.Matrix([[sp.Symbol("x")**2, 1], [0, 2]])))

    def test_assignment_and_comment(self):
        self.assertEqual(equation.equation_output("result = integrate(x, (x, 0, 2))\n# keep the result"), "2")

    def test_assignment_evaluates_once(self):
        source = "values = [1, 2]\nresult = values.pop()"
        self.assertEqual(equation.equation_output(source), "2")

    def test_loops_keep_indentation(self):
        self.assertEqual(equation.equation_output("total = 0\nfor i in range(4):\n    total += i\ntotal"), "6")

    def test_assumptions_survive(self):
        self.assertEqual(equation.equation_output('x = symbols("x", positive=True)\nsqrt(x**2)'), "x")

    def test_solve_a_system(self):
        x, y = sp.symbols("x y")
        self.assertEqual(equation.equation_output("solve([Eq(x+y, 3), Eq(x-y, 1)], [x,y])"), sp.latex({x: 2, y: 1}))

    def test_diagnostics_do_not_pollute_equation(self):
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            self.assertEqual(equation.equation_output('print("working")\nx**2'), "x^{2}")
        self.assertIn("working", log.getvalue())

    def test_no_result_is_reported(self):
        with self.assertRaisesRegex(ValueError, "expression"):
            equation.equation_output("# nothing here")
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "print"):
                equation.equation_output("print(x)")


if __name__ == "__main__":
    unittest.main()
