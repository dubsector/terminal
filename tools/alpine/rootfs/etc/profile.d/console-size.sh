# A serial line can't say how big the terminal at the other end is, so every
# program would assume 80x24. `resize` asks the terminal itself.
if [ -t 0 ] && command -v resize > /dev/null; then
  eval "$(resize)"
fi
