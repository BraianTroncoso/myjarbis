# Medium Doc with Headings

This document exceeds the chunking threshold and uses three H2 sections,
so the importer should produce four chunks (intro + setup + crops + render).

## Setup

This section describes the setup procedure. We pad it past the per-chunk
threshold so the importer is forced to keep the section as its own row
instead of collapsing the document into a single row.

Setup detail 01. Setup detail 02. Setup detail 03. Setup detail 04.
Setup detail 05. Setup detail 06. Setup detail 07. Setup detail 08.
Setup detail 09. Setup detail 10. Setup detail 11. Setup detail 12.
Setup detail 13. Setup detail 14. Setup detail 15. Setup detail 16.
Setup detail 17. Setup detail 18. Setup detail 19. Setup detail 20.
Setup detail 21. Setup detail 22. Setup detail 23. Setup detail 24.
Setup detail 25. Setup detail 26. Setup detail 27. Setup detail 28.
Setup detail 29. Setup detail 30. Setup detail 31. Setup detail 32.
Setup detail 33. Setup detail 34. Setup detail 35. Setup detail 36.
Setup detail 37. Setup detail 38. Setup detail 39. Setup detail 40.
Setup detail 41. Setup detail 42. Setup detail 43. Setup detail 44.
Setup detail 45. Setup detail 46. Setup detail 47. Setup detail 48.
Setup detail 49. Setup detail 50. Setup detail 51. Setup detail 52.
Setup detail 53. Setup detail 54. Setup detail 55. Setup detail 56.
Setup detail 57. Setup detail 58. Setup detail 59. Setup detail 60.
Setup detail 61. Setup detail 62. Setup detail 63. Setup detail 64.
Setup detail 65. Setup detail 66. Setup detail 67. Setup detail 68.
Setup detail 69. Setup detail 70. Setup detail 71. Setup detail 72.
Setup detail 73. Setup detail 74. Setup detail 75. Setup detail 76.
Setup detail 77. Setup detail 78. Setup detail 79. Setup detail 80.

## Crops

Crops are computed by aspect ratio. Each variant lives in
`crop_variants` with a foreign key back to the asset row. Rendering picks
the best match by AR and falls back to the default crop when none apply.

Crops detail 01. Crops detail 02. Crops detail 03. Crops detail 04.
Crops detail 05. Crops detail 06. Crops detail 07. Crops detail 08.
Crops detail 09. Crops detail 10. Crops detail 11. Crops detail 12.
Crops detail 13. Crops detail 14. Crops detail 15. Crops detail 16.
Crops detail 17. Crops detail 18. Crops detail 19. Crops detail 20.
Crops detail 21. Crops detail 22. Crops detail 23. Crops detail 24.
Crops detail 25. Crops detail 26. Crops detail 27. Crops detail 28.
Crops detail 29. Crops detail 30. Crops detail 31. Crops detail 32.
Crops detail 33. Crops detail 34. Crops detail 35. Crops detail 36.
Crops detail 37. Crops detail 38. Crops detail 39. Crops detail 40.
Crops detail 41. Crops detail 42. Crops detail 43. Crops detail 44.
Crops detail 45. Crops detail 46. Crops detail 47. Crops detail 48.
Crops detail 49. Crops detail 50. Crops detail 51. Crops detail 52.
Crops detail 53. Crops detail 54. Crops detail 55. Crops detail 56.

## Render

Rendering walks the page tree and resolves each asset to a public URL.
The CDN layer caches resolved variants for a configurable TTL; cache
invalidation is event-driven from the upstream asset table.

Render detail 01. Render detail 02. Render detail 03. Render detail 04.
Render detail 05. Render detail 06. Render detail 07. Render detail 08.
Render detail 09. Render detail 10. Render detail 11. Render detail 12.
Render detail 13. Render detail 14. Render detail 15. Render detail 16.
Render detail 17. Render detail 18. Render detail 19. Render detail 20.
Render detail 21. Render detail 22. Render detail 23. Render detail 24.
Render detail 25. Render detail 26. Render detail 27. Render detail 28.
Render detail 29. Render detail 30. Render detail 31. Render detail 32.
Render detail 33. Render detail 34. Render detail 35. Render detail 36.
Render detail 37. Render detail 38. Render detail 39. Render detail 40.
Render detail 41. Render detail 42. Render detail 43. Render detail 44.
Render detail 45. Render detail 46. Render detail 47. Render detail 48.
Render detail 49. Render detail 50. Render detail 51. Render detail 52.
Render detail 53. Render detail 54. Render detail 55. Render detail 56.
